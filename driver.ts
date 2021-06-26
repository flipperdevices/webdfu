import { DFUseCommands, DFUseMemorySegment, parseMemoryDescriptor, WebDFUError } from "./core";

import { WebDFULog, WebDFUSettings } from "./core";

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

export class DriverDFU {
  connected: boolean = false;

  logInfo: (msg: string) => void;
  logWarning: (msg: string) => void;
  logProgress: (done: number, total?: number) => void;

  dfuseStartAddress: number = NaN;
  dfuseMemoryInfo?: { name: string; segments: DFUseMemorySegment[] };

  constructor(public device: USBDevice, public settings: WebDFUSettings, log?: WebDFULog) {
    this.logInfo = log?.info ?? (() => {});
    this.logWarning = log?.warning ?? (() => {});
    this.logProgress = log?.progress ?? (() => {});

    if (this.settings.name) {
      this.dfuseMemoryInfo = parseMemoryDescriptor(this.settings.name);
    }
  }

  protected get intfNumber(): number {
    return this.settings.interface.interfaceNumber;
  }

  protected async requestOut(bRequest: number, data?: BufferSource, wValue = 0): Promise<number> {
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

  protected async requestIn(bRequest: number, wLength: number, wValue = 0): Promise<DataView> {
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

  protected download(data: ArrayBuffer, blockNum: number) {
    return this.requestOut(dfuCommands.DOWNLOAD, data, blockNum);
  }

  protected upload(length: number, blockNum: number) {
    return this.requestIn(dfuCommands.UPLOAD, length, blockNum);
  }

  // Control
  async open() {
    const confValue = this.settings.configuration.configurationValue;

    if (!this.device.configuration || this.device.configuration.configurationValue !== confValue) {
      await this.device.selectConfiguration(confValue);
    }

    if (!this.device.configuration) {
      throw new WebDFUError(`Couldn't select the configuration '${confValue}'`);
    }

    const intfNumber = this.settings["interface"].interfaceNumber;
    if (!this.device.configuration.interfaces[intfNumber]?.claimed) {
      await this.device.claimInterface(intfNumber);
    }

    const altSetting = this.settings.alternate.alternateSetting;
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

  // IDLE
  async abortToIdle() {
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

  async poll_until(state_predicate: (state: number) => boolean) {
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

  poll_until_idle(idle_state: number) {
    return this.poll_until((state: number) => state == idle_state);
  }

  async do_read(xfer_size: number, max_size = Infinity, first_block = 0): Promise<Blob> {
    let transaction = first_block;
    let blocks = [];
    let bytes_read = 0;

    this.logInfo("Copying data from DFU device to browser");
    // Initialize progress to 0
    this.logProgress(0);

    let result;
    let bytes_to_read;
    do {
      bytes_to_read = Math.min(xfer_size, max_size - bytes_read);
      result = await this.upload(bytes_to_read, transaction++);
      if (result.byteLength > 0) {
        blocks.push(result);
        bytes_read += result.byteLength;
      }
      if (Number.isFinite(max_size)) {
        this.logProgress(bytes_read, max_size);
      } else {
        this.logProgress(bytes_read);
      }
    } while (bytes_read < max_size && result.byteLength == bytes_to_read);

    if (bytes_read == max_size) {
      await this.abortToIdle();
    }

    this.logInfo(`Read ${bytes_read} bytes`);

    return new Blob(blocks, { type: "application/octet-stream" });
  }

  async do_write(xfer_size: number, data: ArrayBuffer, manifestationTolerant = true): Promise<void> {
    let bytes_sent = 0;
    let expected_size = data.byteLength;
    let transaction = 0;

    this.logInfo("Copying data from browser to DFU device");

    // Initialize progress to 0
    this.logProgress(bytes_sent, expected_size);

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

      this.logProgress(bytes_sent, expected_size);
    }

    try {
      await this.download(new ArrayBuffer(0), transaction++);
    } catch (error) {
      throw new WebDFUError("Error during final DFU download: " + error);
    }

    this.logInfo("Wrote " + bytes_sent + " bytes");
    this.logInfo("Manifesting new firmware");

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
          this.logWarning("Unable to poll final manifestation status");
        } else {
          throw new WebDFUError("Error during DFU manifest: " + error);
        }
      }
    } else {
      // Try polling once to initiate manifestation
      try {
        let final_status = await this.getStatus();

        this.logInfo(`Final DFU status: state=${final_status.state}, status=${final_status.status}`);
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
  async do_dfuse_write(xfer_size: number, data: ArrayBuffer) {
    if (!this.dfuseMemoryInfo || !this.dfuseMemoryInfo.segments) {
      throw new WebDFUError("No memory map available");
    }

    this.logInfo("Erasing DFU device memory");

    let bytes_sent = 0;
    let expected_size = data.byteLength;

    let startAddress: number | undefined = this.dfuseStartAddress;

    if (isNaN(startAddress)) {
      startAddress = this.dfuseMemoryInfo.segments[0]?.start;

      if (!startAddress) {
        throw new WebDFUError("startAddress not found");
      }

      this.logWarning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getDfuseSegment(startAddress) === null) {
      throw new WebDFUError(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }

    await this.erase(startAddress, expected_size);

    this.logInfo("Copying data from browser to DFU device");

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

      this.logProgress(bytes_sent, expected_size);
    }
    this.logInfo(`Wrote ${bytes_sent} bytes`);

    this.logInfo("Manifesting new firmware");
    try {
      await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
      await this.download(new ArrayBuffer(0), 0);
    } catch (error) {
      throw new WebDFUError("Error during DfuSe manifestation: " + error);
    }

    await this.poll_until((state) => state == dfuCommands.dfuMANIFEST);
  }

  async do_dfuse_read(xfer_size: number, max_size = Infinity) {
    if (!this.dfuseMemoryInfo) {
      throw new WebDFUError("Unknown a DfuSe memory info");
    }

    let startAddress: number | undefined = this.dfuseStartAddress;
    if (isNaN(startAddress)) {
      startAddress = this.dfuseMemoryInfo.segments[0]?.start;
      if (!startAddress) {
        throw new WebDFUError("Unknown memory segments");
      }
      this.logWarning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getDfuseSegment(startAddress) === null) {
      this.logWarning(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }

    this.logInfo(`Reading up to 0x${max_size.toString(16)} bytes starting at 0x${startAddress.toString(16)}`);
    let state = await this.getState();
    if (state != dfuCommands.dfuIDLE) {
      await this.abortToIdle();
    }
    await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
    await this.abortToIdle();

    // DfuSe encodes the read address based on the transfer size,
    // the block number - 2, and the SET_ADDRESS pointer.
    return await DriverDFU.prototype.do_read.call(this, xfer_size, max_size, 2);
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

  private async erase(startAddr: number, length: number) {
    let segment = this.getDfuseSegment(startAddr);
    let addr = this.getDfuseSectorStart(startAddr, segment);
    const endAddr = this.getDfuseSectorEnd(startAddr + length - 1);

    if (!segment) {
      throw new WebDFUError("Unknown segment");
    }

    let bytesErased = 0;
    const bytesToErase = endAddr - addr;
    if (bytesToErase > 0) {
      this.logProgress(bytesErased, bytesToErase);
    }

    while (addr < endAddr) {
      if ((segment?.end ?? 0) <= addr) {
        segment = this.getDfuseSegment(addr);
      }

      if (!segment?.erasable) {
        // Skip over the non-erasable section
        bytesErased = Math.min(bytesErased + (segment?.end ?? 0) - addr, bytesToErase);
        addr = segment?.end ?? 0;
        this.logProgress(bytesErased, bytesToErase);
        continue;
      }

      const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
      const sectorAddr = segment.start + sectorIndex * segment.sectorSize;
      await this.dfuseCommand(DFUseCommands.ERASE_SECTOR, sectorAddr, 4);
      addr = sectorAddr + segment.sectorSize;
      bytesErased += segment.sectorSize;
      this.logProgress(bytesErased, bytesToErase);
    }
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
