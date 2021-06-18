import {
  WebDFUDeviceDescriptor,
  WebDFUFunctionalDescriptor,
  WebDFUInterfaceDescriptor,
  WebDFUInterfaceSubDescriptor,
  WebDFULog,
  WebDFUSettings,
} from "./types";
import { WebDFUError } from "./core";

export const dfuCommands = {
  DETACH: 0x00,
  DNLOAD: 0x01,
  UPLOAD: 0x02,
  GETSTATUS: 0x03,
  CLRSTATUS: 0x04,
  GETSTATE: 0x05,
  ABORT: 0x06,

  appIDLE: 0,
  appDETACH: 1,

  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuUPLOAD_IDLE: 9,
  dfuERROR: 10,

  STATUS_OK: 0x0,
};

export abstract class WebDFUDriver {
  connected: boolean = false;

  logDebug: (msg: string) => void;
  logInfo: (msg: string) => void;
  logWarning: (msg: string) => void;
  logError: (msg: string) => void;
  logProgress: (done: number, total?: number) => void;

  constructor(public device: USBDevice, public settings: WebDFUSettings, log?: WebDFULog) {
    this.logDebug = log?.debug ?? (() => {});
    this.logInfo = log?.info ?? (() => {});
    this.logWarning = log?.warning ?? (() => {});
    this.logError = log?.error ?? (() => {});
    this.logProgress = log?.progress ?? (() => {});
  }

  abstract do_write(xfer_size: number, data: ArrayBuffer, manifestationTolerant: boolean): Promise<void>;
  abstract do_read(xfer_size: number, max_size: number): Promise<Blob>;

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
    return this.requestOut(dfuCommands.DNLOAD, data, blockNum);
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

    let device = this;

    function async_sleep(duration_ms: number) {
      return new Promise((resolve) => {
        device.logDebug("Sleeping for " + duration_ms + "ms");
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

  // Static utils
  static parseDeviceDescriptor(data: DataView): WebDFUDeviceDescriptor {
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      bcdUSB: data.getUint16(2, true),
      bDeviceClass: data.getUint8(4),
      bDeviceSubClass: data.getUint8(5),
      bDeviceProtocol: data.getUint8(6),
      bMaxPacketSize: data.getUint8(7),
      idVendor: data.getUint16(8, true),
      idProduct: data.getUint16(10, true),
      bcdDevice: data.getUint16(12, true),
      iManufacturer: data.getUint8(14),
      iProduct: data.getUint8(15),
      iSerialNumber: data.getUint8(16),
      bNumConfigurations: data.getUint8(17),
    };
  }

  static parseFunctionalDescriptor(data: DataView): WebDFUFunctionalDescriptor {
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      bmAttributes: data.getUint8(2),
      wDetachTimeOut: data.getUint16(3, true),
      wTransferSize: data.getUint16(5, true),
      bcdDFUVersion: data.getUint16(7, true),
    };
  }

  static parseInterfaceDescriptor(data: DataView): WebDFUInterfaceDescriptor {
    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      bInterfaceNumber: data.getUint8(2),
      bAlternateSetting: data.getUint8(3),
      bNumEndpoints: data.getUint8(4),
      bInterfaceClass: data.getUint8(5),
      bInterfaceSubClass: data.getUint8(6),
      bInterfaceProtocol: data.getUint8(7),
      iInterface: data.getUint8(8),
      descriptors: [],
    };
  }

  static parseSubDescriptors(descriptorData: DataView) {
    const DT_INTERFACE = 4;
    // const DT_ENDPOINT = 5;
    const DT_DFU_FUNCTIONAL = 0x21;
    const USB_CLASS_APP_SPECIFIC = 0xfe;
    const USB_SUBCLASS_DFU = 0x01;

    let remainingData: DataView = descriptorData;
    let descriptors = [];
    let currIntf;
    let inDfuIntf = false;

    while (remainingData.byteLength > 2) {
      let bLength = remainingData.getUint8(0);
      let bDescriptorType = remainingData.getUint8(1);
      let descData = new DataView(remainingData.buffer.slice(0, bLength));
      if (bDescriptorType == DT_INTERFACE) {
        currIntf = WebDFUDriver.parseInterfaceDescriptor(descData);
        if (currIntf.bInterfaceClass == USB_CLASS_APP_SPECIFIC && currIntf.bInterfaceSubClass == USB_SUBCLASS_DFU) {
          inDfuIntf = true;
        } else {
          inDfuIntf = false;
        }
        descriptors.push(currIntf);
      } else if (inDfuIntf && bDescriptorType == DT_DFU_FUNCTIONAL) {
        let funcDesc = WebDFUDriver.parseFunctionalDescriptor(descData);
        descriptors.push(funcDesc);
        currIntf?.descriptors.push(funcDesc);
      } else {
        let desc = {
          bLength: bLength,
          bDescriptorType: bDescriptorType,
          descData: descData,
        } as WebDFUInterfaceSubDescriptor;
        descriptors.push(desc);
        if (currIntf) {
          currIntf.descriptors.push(desc);
        }
      }
      remainingData = new DataView(remainingData.buffer.slice(bLength));
    }

    return descriptors;
  }

  static parseConfigurationDescriptor(data: DataView) {
    let descriptorData = new DataView(data.buffer.slice(9));
    let descriptors = WebDFUDriver.parseSubDescriptors(descriptorData);

    return {
      bLength: data.getUint8(0),
      bDescriptorType: data.getUint8(1),
      wTotalLength: data.getUint16(2, true),
      bNumInterfaces: data.getUint8(4),
      bConfigurationValue: data.getUint8(5),
      iConfiguration: data.getUint8(6),
      bmAttributes: data.getUint8(7),
      bMaxPower: data.getUint8(8),
      descriptors: descriptors,
    };
  }
}
