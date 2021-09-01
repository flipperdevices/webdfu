import { createNanoEvents } from "nanoevents";

import {
  WebDFUSettings,
  WebDFUEvent,
  WebDFUOptions,
  WebDFUProperties,
  WebDFUType,
  WebDFULog,
  WebDFUInterfaceSubDescriptor,
  WebDFUInterfaceDescriptor,
  parseMemoryDescriptor,
  DFUseMemorySegment,
  DFUseCommands,
} from "./core";
import { WebDFUProcessErase, WebDFUProcessRead, WebDFUProcessWrite } from "./process";
import { parseConfigurationDescriptor, WebDFUError } from "./core";

export * from "./core";

export const dfuCommands = {
  DETACH: 0x00,
  DOWNLOAD: 0x01,
  UPLOAD: 0x02,
  GETSTATUS: 0x03,
  CLRSTATUS: 0x04,
  GETSTATE: 0x05,
  ABORT: 0x06,

  appIDLE: 0,
  appDETACH: 1,

  dfuIDLE: 2,
  dfuDOWNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDOWNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,

  STATUS_OK: 0x0,
};

export class WebDFU {
  events = createNanoEvents<WebDFUEvent>();

  interfaces: WebDFUSettings[] = [];
  properties?: WebDFUProperties;

  connected: boolean = false;

  dfuseStartAddress: number = NaN;
  dfuseMemoryInfo?: { name: string; segments: DFUseMemorySegment[] };
  currentInterfaceSettings?: WebDFUSettings;

  constructor(
    public readonly device: USBDevice,
    public readonly settings: WebDFUOptions = {},
    private readonly log: WebDFULog
  ) {}

  get type(): number {
    if (this.properties?.DFUVersion == 0x011a && this.currentInterfaceSettings?.alternate.interfaceProtocol == 0x02) {
      return WebDFUType.SDFUse;
    }

    return WebDFUType.DFU;
  }

  async init(): Promise<void> {
    this.interfaces = await this.findDfuInterfaces();
    this.events.emit("init");
  }

  async connect(interfaceIndex: number): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }

    // Attempt to parse the DFU functional descriptor
    let desc: WebDFUProperties | null = null;
    try {
      desc = await this.getDFUDescriptorProperties();
    } catch (error) {
      this.events.emit("disconnect", error);
      throw error;
    }

    const intrf = this.interfaces[interfaceIndex];

    if (!intrf) {
      throw new WebDFUError("Interface not found");
    }

    this.currentInterfaceSettings = intrf;
    if (this.currentInterfaceSettings.name) {
      this.dfuseMemoryInfo = parseMemoryDescriptor(this.currentInterfaceSettings.name);
    }

    if (desc) {
      this.properties = desc;
    }

    try {
      await this.open();
    } catch (error) {
      this.events.emit("disconnect", error);
      throw error;
    }

    this.events.emit("connect");
  }

  async close() {
    await this.device.close();
    this.events.emit("disconnect");
  }

  read(xferSize: number, maxSize: number): WebDFUProcessRead {
    if (!this) {
      throw new WebDFUError("Required initialized driver");
    }

    const process = new WebDFUProcessRead();

    try {
      let blob: Promise<Blob>;
      if (this.type === WebDFUType.SDFUse) {
        blob = this.do_dfuse_read(process, xferSize, maxSize);
      } else {
        blob = this.do_read(process, xferSize, maxSize);
      }

      blob.then((data) => process.events.emit("end", data)).catch((error) => process.events.emit("error", error));
    } catch (error) {
      process.events.emit("error", error);
    }

    return process;
  }

  write(xfer_size: number, data: ArrayBuffer, manifestationTolerant: boolean): WebDFUProcessWrite {
    if (!this) {
      throw new WebDFUError("Required initialized driver");
    }

    let process = new WebDFUProcessWrite();

    setTimeout(() => {
      try {
        let result: Promise<void>;

        if (this.type === WebDFUType.SDFUse) {
          result = this.do_dfuse_write(process, xfer_size, data);
        } else {
          result = this.do_write(process, xfer_size, data, manifestationTolerant);
        }

        result.then(() => process.events.emit("end")).catch((error) => process.events.emit("error", error));
      } catch (error) {
        process.events.on("error", error);
      }
    }, 0);

    return process;
  }

  // Attempt to read the DFU functional descriptor
  // TODO: read the selected configuration's descriptor
  private async getDFUDescriptorProperties(): Promise<WebDFUProperties | null> {
    const data = await this.readConfigurationDescriptor(0);

    let configDesc = parseConfigurationDescriptor(data);
    let funcDesc: WebDFUInterfaceSubDescriptor | null = null;
    let configValue = this.device.configuration?.configurationValue;
    if (configDesc.bConfigurationValue == configValue) {
      for (let desc of configDesc.descriptors) {
        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
          funcDesc = desc as WebDFUInterfaceSubDescriptor;
          break;
        }
      }
    }

    if (!funcDesc) {
      return null;
    }

    return {
      WillDetach: (funcDesc.bmAttributes & 0x08) != 0,
      ManifestationTolerant: (funcDesc.bmAttributes & 0x04) != 0,
      CanUpload: (funcDesc.bmAttributes & 0x02) != 0,
      CanDownload: (funcDesc.bmAttributes & 0x01) != 0,
      TransferSize: funcDesc.wTransferSize,
      DetachTimeOut: funcDesc.wDetachTimeOut,
      DFUVersion: funcDesc.bcdDFUVersion,
    };
  }

  private async findDfuInterfaces(): Promise<WebDFUSettings[]> {
    const interfaces = [];

    for (let conf of this.device.configurations) {
      for (let intf of conf.interfaces) {
        for (let alt of intf.alternates) {
          if (
            alt.interfaceClass == 0xfe &&
            alt.interfaceSubclass == 0x01 &&
            (alt.interfaceProtocol == 0x01 || alt.interfaceProtocol == 0x02)
          ) {
            interfaces.push({
              configuration: conf,
              interface: intf,
              alternate: alt,
              name: alt.interfaceName,
            });
          }
        }
      }
    }

    if (this.settings.forceInterfacesName) {
      // Need force
      await this.fixInterfaceNames(interfaces);
    }

    return interfaces;
  }

  private async fixInterfaceNames(interfaces: WebDFUSettings[]) {
    // Check if any interface names were not read correctly
    if (interfaces.some((intf) => intf.name == null)) {
      await this.device.open();
      await this.device.selectConfiguration(1);

      let mapping = await this.readInterfaceNames();

      for (let intf of interfaces) {
        if (intf.name === null) {
          let configIndex = intf.configuration.configurationValue;
          let intfNumber = intf["interface"].interfaceNumber;
          let alt = intf.alternate.alternateSetting;
          intf.name = mapping?.[configIndex]?.[intfNumber]?.[alt]?.toString();
        }
      }
    }
  }

  private async readStringDescriptor(index: number, langID = 0) {
    const GET_DESCRIPTOR = 0x06;
    const DT_STRING = 0x03;
    const wValue = (DT_STRING << 8) | index;

    const request_setup: USBControlTransferParameters = {
      requestType: "standard",
      recipient: "device",
      request: GET_DESCRIPTOR,
      value: wValue,
      index: langID,
    };

    // Read enough for bLength
    let result = await this.device.controlTransferIn(request_setup, 1);

    if (result.data && result.status == "ok") {
      // Retrieve the full descriptor
      const bLength = result.data.getUint8(0);
      result = await this.device.controlTransferIn(request_setup, bLength);
      if (result.data && result.status == "ok") {
        const len = (bLength - 2) / 2;
        let u16_words = [];
        for (let i = 0; i < len; i++) {
          u16_words.push(result.data.getUint16(2 + i * 2, true));
        }
        if (langID == 0) {
          // Return the langID array
          return u16_words;
        } else {
          // Decode from UCS-2 into a string
          return String.fromCharCode.apply(String, u16_words);
        }
      }
    }

    throw new WebDFUError(`Failed to read string descriptor ${index}: ${result.status}`);
  }

  // @ts-ignore
  private async readDeviceDescriptor(): Promise<DataView> {
    const GET_DESCRIPTOR = 0x06;
    const DT_DEVICE = 0x01;
    const wValue = DT_DEVICE << 8;

    const result = await this.device.controlTransferIn(
      {
        requestType: "standard",
        recipient: "device",
        request: GET_DESCRIPTOR,
        value: wValue,
        index: 0,
      },
      18
    );

    if (!result.data || result.status !== "ok") {
      throw new WebDFUError(`Failed to read device descriptor: ${result.status}`);
    }

    return result.data;
  }

  private async readInterfaceNames() {
    const DT_INTERFACE = 4;

    let configs: Record<number, Record<number, Record<number, number>>> = {};
    let allStringIndices = new Set<any>();
    for (let configIndex = 0; configIndex < this.device.configurations.length; configIndex++) {
      const rawConfig = await this.readConfigurationDescriptor(configIndex);
      let configDesc = parseConfigurationDescriptor(rawConfig);
      let configValue = configDesc.bConfigurationValue;
      configs[configValue] = {};

      // Retrieve string indices for interface names
      for (let desc of configDesc.descriptors) {
        if (desc.bDescriptorType === DT_INTERFACE) {
          desc = desc as WebDFUInterfaceDescriptor;

          if (!configs[configValue]?.[desc.bInterfaceNumber]) {
            configs[configValue]![desc.bInterfaceNumber] = {};
          }

          configs[configValue]![desc.bInterfaceNumber]![desc.bAlternateSetting] = desc.iInterface;

          if (desc.iInterface > 0) {
            allStringIndices.add(desc.iInterface);
          }
        }
      }
    }

    let strings: any = {};

    // Retrieve interface name strings
    for (let index of allStringIndices) {
      try {
        strings[index] = await this.readStringDescriptor(index, 0x0409);
      } catch (error) {
        console.log(error);
        strings[index] = null;
      }
    }

    for (let config of Object.values(configs)) {
      for (let intf of Object.values(config)) {
        for (let alt in intf) {
          intf[alt] = strings[intf[alt]!];
        }
      }
    }

    return configs;
  }

  private async readConfigurationDescriptor(index: number): Promise<DataView> {
    const GET_DESCRIPTOR = 0x06;
    const DT_CONFIGURATION = 0x02;
    const wValue = (DT_CONFIGURATION << 8) | index;

    const setup: USBControlTransferParameters = {
      requestType: "standard",
      recipient: "device",
      request: GET_DESCRIPTOR,
      value: wValue,
      index: 0,
    };

    const descriptorSize = await this.device.controlTransferIn(setup, 4);

    if (!descriptorSize.data || descriptorSize.status !== "ok") {
      throw new WebDFUError(`controlTransferIn error. [status]: ${descriptorSize.status}`);
    }

    // Read out length of the configuration descriptor
    let wLength = descriptorSize.data.getUint16(2, true);

    const descriptor = await this.device.controlTransferIn(setup, wLength);

    if (!descriptor.data || descriptor.status !== "ok") {
      throw new WebDFUError(`controlTransferIn error. [status]: ${descriptor.status}`);
    }

    return descriptor.data;
  }

  // Control
  async open() {
    if (!this.currentInterfaceSettings) {
      throw new WebDFUError("Required selected interface");
    }

    const confValue = this.currentInterfaceSettings.configuration.configurationValue;

    if (!this.device.configuration || this.device.configuration.configurationValue !== confValue) {
      await this.device.selectConfiguration(confValue);
    }

    if (!this.device.configuration) {
      throw new WebDFUError(`Couldn't select the configuration '${confValue}'`);
    }

    const intfNumber = this.currentInterfaceSettings["interface"].interfaceNumber;
    if (!this.device.configuration.interfaces[intfNumber]?.claimed) {
      await this.device.claimInterface(intfNumber);
    }

    const altSetting = this.currentInterfaceSettings.alternate.alternateSetting;
    let intf = this.device.configuration.interfaces[intfNumber];
    if (!intf?.alternate || intf.alternate.alternateSetting != altSetting) {
      await this.device.selectAlternateInterface(intfNumber, altSetting);
    }
  }

  detach() {
    return this.requestOut(dfuCommands.DETACH, undefined, 1000);
  }

  abort() {
    return this.requestOut(dfuCommands.ABORT);
  }

  async waitDisconnected(timeout: number) {
    let device = this;
    let usbDevice = this.device;

    return new Promise((resolve, reject) => {
      let timeoutID: number;

      function onDisconnect(event: USBConnectionEvent) {
        if (event.device === usbDevice) {
          if (timeout > 0) {
            clearTimeout(timeoutID);
          }
          device.connected = false;
          navigator.usb.removeEventListener("disconnect", onDisconnect);
          event.stopPropagation();
          resolve(device);
        }
      }

      if (timeout > 0) {
        timeoutID = window.setTimeout(() => {
          navigator.usb.removeEventListener("disconnect", onDisconnect);

          if (device.connected) {
            reject("Disconnect timeout expired");
          }
        }, timeout);
      } else {
        navigator.usb.addEventListener("disconnect", onDisconnect);
      }
    });
  }

  // Status
  async isError() {
    try {
      const state = await this.getStatus();

      if (!state) {
        return true;
      }

      return state?.state == dfuCommands.dfuERROR;
    } catch (_) {
      return true;
    }
  }

  getState() {
    return this.requestIn(dfuCommands.GETSTATE, 1).then(
      (data) => Promise.resolve(data.getUint8(0)),
      (error) => Promise.reject("DFU GETSTATE failed: " + error)
    );
  }

  getStatus() {
    return this.requestIn(dfuCommands.GETSTATUS, 6).then(
      (data) =>
        Promise.resolve({
          status: data.getUint8(0),
          pollTimeout: data.getUint32(1, true) & 0xffffff,
          state: data.getUint8(4),
        }),
      (error) => Promise.reject("DFU GETSTATUS failed: " + error)
    );
  }

  clearStatus() {
    return this.requestOut(dfuCommands.CLRSTATUS);
  }

  /* Driver options */
  private get intfNumber(): number {
    if (!this.currentInterfaceSettings) {
      throw new WebDFUError("Required selected interface");
    }

    return this.currentInterfaceSettings.interface.interfaceNumber;
  }

  private async requestOut(bRequest: number, data?: BufferSource, wValue = 0): Promise<number> {
    try {
      const result = await this.device.controlTransferOut(
        {
          requestType: "class",
          recipient: "interface",
          request: bRequest,
          value: wValue,
          index: this.intfNumber,
        },
        data
      );

      if (result.status !== "ok") {
        throw new WebDFUError(result.status);
      }

      return result.bytesWritten;
    } catch (error) {
      throw new WebDFUError("ControlTransferOut failed: " + error);
    }
  }

  private async requestIn(bRequest: number, wLength: number, wValue = 0): Promise<DataView> {
    try {
      const result = await this.device.controlTransferIn(
        {
          requestType: "class",
          recipient: "interface",
          request: bRequest,
          value: wValue,
          index: this.intfNumber,
        },
        wLength
      );

      if (result.status !== "ok" || !result.data) {
        throw new WebDFUError(result.status);
      }

      return result.data;
    } catch (error) {
      throw new WebDFUError("ControlTransferIn failed: " + error);
    }
  }

  private download(data: ArrayBuffer, blockNum: number) {
    return this.requestOut(dfuCommands.DOWNLOAD, data, blockNum);
  }

  private upload(length: number, blockNum: number) {
    return this.requestIn(dfuCommands.UPLOAD, length, blockNum);
  }

  // IDLE
  private async abortToIdle() {
    await this.abort();
    let state = await this.getState();
    if (state == dfuCommands.dfuERROR) {
      await this.clearStatus();
      state = await this.getState();
    }
    if (state != dfuCommands.dfuIDLE) {
      throw new WebDFUError("Failed to return to idle state after abort: state " + state);
    }
  }

  private async poll_until(state_predicate: (state: number) => boolean) {
    let dfu_status = await this.getStatus();

    function async_sleep(duration_ms: number) {
      return new Promise((resolve) => {
        setTimeout(resolve, duration_ms);
      });
    }

    while (!state_predicate(dfu_status.state) && dfu_status.state != dfuCommands.dfuERROR) {
      await async_sleep(dfu_status.pollTimeout);
      dfu_status = await this.getStatus();
    }

    return dfu_status;
  }

  private poll_until_idle(idle_state: number) {
    return this.poll_until((state: number) => state == idle_state);
  }

  private async do_read(
    process: WebDFUProcessRead,
    xfer_size: number,
    max_size = Infinity,
    first_block = 0
  ): Promise<Blob> {
    let transaction = first_block;
    let blocks = [];
    let bytes_read = 0;

    // Initialize progress to 0
    process.events.emit("process", 0);

    let result;
    let bytes_to_read;
    do {
      bytes_to_read = Math.min(xfer_size, max_size - bytes_read);
      result = await this.upload(bytes_to_read, transaction++);
      if (result.byteLength > 0) {
        blocks.push(result);
        bytes_read += result.byteLength;
      }

      process.events.emit("process", bytes_read, Number.isFinite(max_size) ? max_size : undefined);
    } while (bytes_read < max_size && result.byteLength == bytes_to_read);

    if (bytes_read == max_size) {
      await this.abortToIdle();
    }

    return new Blob(blocks, { type: "application/octet-stream" });
  }

  private async do_write(
    process: WebDFUProcessWrite,
    xfer_size: number,
    data: ArrayBuffer,
    manifestationTolerant = true
  ): Promise<void> {
    let bytes_sent = 0;
    let expected_size = data.byteLength;
    let transaction = 0;

    process.events.emit("write/start");

    // Initialize progress to 0
    process.events.emit("write/process", bytes_sent, expected_size);

    while (bytes_sent < expected_size) {
      const bytes_left = expected_size - bytes_sent;
      const chunk_size = Math.min(bytes_left, xfer_size);

      let bytes_written = 0;
      let dfu_status;
      try {
        bytes_written = await this.download(data.slice(bytes_sent, bytes_sent + chunk_size), transaction++);
        dfu_status = await this.poll_until_idle(dfuCommands.dfuDOWNLOAD_IDLE);
      } catch (error) {
        throw new WebDFUError("Error during DFU download: " + error);
      }

      if (dfu_status.status != dfuCommands.STATUS_OK) {
        throw new WebDFUError(`DFU DOWNLOAD failed state=${dfu_status.state}, status=${dfu_status.status}`);
      }

      bytes_sent += bytes_written;

      process.events.emit("write/process", bytes_sent, expected_size);
    }

    try {
      await this.download(new ArrayBuffer(0), transaction++);
    } catch (error) {
      throw new WebDFUError("Error during final DFU download: " + error);
    }

    process.events.emit("write/end", bytes_sent);

    if (manifestationTolerant) {
      // Transition to MANIFEST_SYNC state
      let dfu_status;
      try {
        // Wait until it returns to idle.
        // If it's not really manifestation tolerant, it might transition to MANIFEST_WAIT_RESET
        dfu_status = await this.poll_until(
          (state) => state == dfuCommands.dfuIDLE || state == dfuCommands.dfuMANIFEST_WAIT_RESET
        );

        // if dfu_status.state == dfuCommands.dfuMANIFEST_WAIT_RESET
        // => Device transitioned to MANIFEST_WAIT_RESET even though it is manifestation tolerant

        if (dfu_status.status != dfuCommands.STATUS_OK) {
          throw new WebDFUError(`DFU MANIFEST failed state=${dfu_status.state}, status=${dfu_status.status}`);
        }
      } catch (error) {
        if (
          error.endsWith("ControlTransferIn failed: NotFoundError: Device unavailable.") ||
          error.endsWith("ControlTransferIn failed: NotFoundError: The device was disconnected.")
        ) {
          this.log.warning("Unable to poll final manifestation status");
        } else {
          throw new WebDFUError("Error during DFU manifest: " + error);
        }
      }
    } else {
      // Try polling once to initiate manifestation
      try {
        await this.getStatus();
      } catch (error) {}
    }

    // Reset to exit MANIFEST_WAIT_RESET
    try {
      await this.device.reset();
    } catch (error) {
      if (
        error == "NetworkError: Unable to reset the device." ||
        error == "NotFoundError: Device unavailable." ||
        error == "NotFoundError: The device was disconnected."
      ) {
        // Ignored reset error
      } else {
        throw new WebDFUError("Error during reset for manifestation: " + error);
      }
    }
  }

  // DFUse specific
  private async do_dfuse_write(process: WebDFUProcessWrite, xfer_size: number, data: ArrayBuffer) {
    if (!this.dfuseMemoryInfo || !this.dfuseMemoryInfo.segments) {
      throw new WebDFUError("No memory map available");
    }

    process.events.emit("erase/start");

    let bytes_sent = 0;
    let expected_size = data.byteLength;

    let startAddress: number | undefined = this.dfuseStartAddress;

    if (isNaN(startAddress)) {
      startAddress = this.dfuseMemoryInfo.segments[0]?.start;

      if (!startAddress) {
        throw new WebDFUError("startAddress not found");
      }

      this.log.warning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getDfuseSegment(startAddress) === null && data.byteLength !== 0) {
      throw new WebDFUError(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }

    await new Promise<void>((resolve, reject) => {
      if (!startAddress) {
        reject(new WebDFUError("startAddress not found"));
        return;
      }

      const ev = this.erase(startAddress, expected_size);

      ev.events.on("process", (...args) => process.events.emit("erase/process", ...args));
      ev.events.on("error", reject);
      ev.events.on("end", () => {
        process.events.emit("erase/end");
        resolve();
      });
    });

    process.events.emit("write/start");

    let address = startAddress;
    while (bytes_sent < expected_size) {
      const bytes_left = expected_size - bytes_sent;
      const chunk_size = Math.min(bytes_left, xfer_size);

      let bytes_written = 0;
      let dfu_status;
      try {
        await this.dfuseCommand(DFUseCommands.SET_ADDRESS, address, 4);
        bytes_written = await this.download(data.slice(bytes_sent, bytes_sent + chunk_size), 2);
        dfu_status = await this.poll_until_idle(dfuCommands.dfuDOWNLOAD_IDLE);
        address += chunk_size;
      } catch (error) {
        throw new WebDFUError("Error during DfuSe download: " + error);
      }

      if (dfu_status.status != dfuCommands.STATUS_OK) {
        throw new WebDFUError(`DFU DOWNLOAD failed state=${dfu_status.state}, status=${dfu_status.status}`);
      }

      bytes_sent += bytes_written;

      process.events.emit("write/process", bytes_sent, expected_size);
    }

    process.events.emit("write/end", bytes_sent);

    try {
      await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
      await this.download(new ArrayBuffer(0), 0);
    } catch (error) {
      throw new WebDFUError("Error during DfuSe manifestation: " + error);
    }

    await this.poll_until((state) => state == dfuCommands.dfuMANIFEST);
  }

  private async do_dfuse_read(process: WebDFUProcessRead, xfer_size: number, max_size = Infinity) {
    if (!this.dfuseMemoryInfo) {
      throw new WebDFUError("Unknown a DfuSe memory info");
    }

    let startAddress: number | undefined = this.dfuseStartAddress;
    if (isNaN(startAddress)) {
      startAddress = this.dfuseMemoryInfo.segments[0]?.start;
      if (!startAddress) {
        throw new WebDFUError("Unknown memory segments");
      }
      this.log.warning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getDfuseSegment(startAddress) === null) {
      this.log.warning(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }

    let state = await this.getState();
    if (state != dfuCommands.dfuIDLE) {
      await this.abortToIdle();
    }
    await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
    await this.abortToIdle();

    // DfuSe encodes the read address based on the transfer size,
    // the block number - 2, and the SET_ADDRESS pointer.
    return await this.do_read(process, xfer_size, max_size, 2);
  }

  getDfuseSegment(addr: number): DFUseMemorySegment | null {
    if (!this.dfuseMemoryInfo || !this.dfuseMemoryInfo.segments) {
      throw new WebDFUError("No memory map information available");
    }

    for (let segment of this.dfuseMemoryInfo.segments) {
      if (segment.start <= addr && addr < segment.end) {
        return segment;
      }
    }

    return null;
  }

  getDfuseFirstWritableSegment() {
    if (!this.dfuseMemoryInfo || !this.dfuseMemoryInfo.segments) {
      throw new WebDFUError("No memory map information available");
    }

    for (let segment of this.dfuseMemoryInfo.segments) {
      if (segment.writable) {
        return segment;
      }
    }

    return null;
  }

  getDfuseMaxReadSize(startAddr: number) {
    if (!this.dfuseMemoryInfo || !this.dfuseMemoryInfo.segments) {
      throw new WebDFUError("No memory map information available");
    }

    let numBytes = 0;
    for (let segment of this.dfuseMemoryInfo.segments) {
      if (segment.start <= startAddr && startAddr < segment.end) {
        // Found the first segment the read starts in
        if (segment.readable) {
          numBytes += segment.end - startAddr;
        } else {
          return 0;
        }
      } else if (segment.start == startAddr + numBytes) {
        // Include a contiguous segment
        if (segment.readable) {
          numBytes += segment.end - segment.start;
        } else {
          break;
        }
      }
    }

    return numBytes;
  }

  private getDfuseSectorStart(addr: number, segment: DFUseMemorySegment | null) {
    if (typeof segment === "undefined") {
      segment = this.getDfuseSegment(addr);
    }

    if (!segment) {
      throw new WebDFUError(`Address ${addr.toString(16)} outside of memory map`);
    }

    const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
    return segment.start + sectorIndex * segment.sectorSize;
  }

  private getDfuseSectorEnd(addr: number, segment = this.getDfuseSegment(addr)) {
    if (!segment) {
      throw new WebDFUError(`Address ${addr.toString(16)} outside of memory map`);
    }

    const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
    return segment.start + (sectorIndex + 1) * segment.sectorSize;
  }

  private erase(startAddr: number, length: number): WebDFUProcessErase {
    const process = new WebDFUProcessErase();

    const that = this;
    void (async function () {
      let segment = that.getDfuseSegment(startAddr);
      let addr = that.getDfuseSectorStart(startAddr, segment);
      const endAddr = that.getDfuseSectorEnd(startAddr + length - 1);

      if (!segment) {
        throw new WebDFUError("Unknown segment");
      }

      let bytesErased = 0;
      const bytesToErase = endAddr - addr;
      if (bytesToErase > 0) {
        process.events.emit("process", bytesErased, bytesToErase);
      }

      while (addr < endAddr) {
        if ((segment?.end ?? 0) <= addr) {
          segment = that.getDfuseSegment(addr);
        }

        if (!segment?.erasable) {
          // Skip over the non-erasable section
          bytesErased = Math.min(bytesErased + (segment?.end ?? 0) - addr, bytesToErase);
          addr = segment?.end ?? 0;
        } else {
          const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
          const sectorAddr = segment.start + sectorIndex * segment.sectorSize;
          await that.dfuseCommand(DFUseCommands.ERASE_SECTOR, sectorAddr, 4);
          addr = sectorAddr + segment.sectorSize;
          bytesErased += segment.sectorSize;
        }

        process.events.emit("process", bytesErased, bytesToErase);
      }
    })()
      .then(() => process.events.emit("end"))
      .catch((error) => process.events.emit("error", error));

    return process;
  }

  private async dfuseCommand(command: number, param = 0x00, len = 1) {
    const commandNames: Record<number, string> = {
      [DFUseCommands.GET_COMMANDS]: "GET_COMMANDS",
      [DFUseCommands.SET_ADDRESS]: "SET_ADDRESS",
      [DFUseCommands.ERASE_SECTOR]: "ERASE_SECTOR",
    };

    let payload = new ArrayBuffer(len + 1);
    let view = new DataView(payload);
    view.setUint8(0, command);
    if (len == 1) {
      view.setUint8(1, param);
    } else if (len == 4) {
      view.setUint32(1, param, true);
    } else {
      throw new WebDFUError("Don't know how to handle data of len " + len);
    }

    try {
      await this.download(payload, 0);
    } catch (error) {
      throw new WebDFUError("Error during special DfuSe command " + commandNames[command] + ":" + error);
    }

    let status = await this.poll_until((state) => state != dfuCommands.dfuDNBUSY);

    if (status.status != dfuCommands.STATUS_OK) {
      throw new WebDFUError("Special DfuSe command " + command + " failed");
    }
  }
}
