import { WebDFULog, WebDFUSettings } from "./types";
import {
  WebDFUError,
  DFU_COMMAND_ABORT,
  DFU_COMMAND_CLRSTATUS,
  DFU_COMMAND_DETACH,
  DFU_COMMAND_WRITE,
  DFU_COMMAND_GETSTATE,
  DFU_COMMAND_GETSTATUS,
  DFU_COMMAND_READ,
} from "./core";

export const dfuCommands = {
  appIDLE: 0,
  appDETACH: 1,

  dfuIDLE: 2,
  dfuDNLOAD_SYNC: 3,
  dfuDNBUSY: 4,
  dfuDNLOAD_IDLE: 5,
  dfuMANIFEST_SYNC: 6,
  dfuMANIFEST: 7,
  dfuMANIFEST_WAIT_RESET: 8,
  dfuREAD_IDLE: 9,
  dfuERROR: 10,

  STATUS_OK: 0x0,
};

export abstract class WebDFUDriver {
  connected: boolean = false;

  logInfo: (msg: string) => void;
  logWarning: (msg: string) => void;
  logError: (msg: string) => void;
  logProgress: (done: number, total?: number) => void;

  constructor(public device: USBDevice, public settings: WebDFUSettings, log?: WebDFULog) {
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

  protected write(data: ArrayBuffer, blockNum: number) {
    return this.requestOut(DFU_COMMAND_WRITE, data, blockNum);
  }

  protected read(length: number, blockNum: number) {
    return this.requestIn(DFU_COMMAND_READ, length, blockNum);
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
    return this.requestOut(DFU_COMMAND_DETACH, undefined, 1000);
  }

  abort() {
    return this.requestOut(DFU_COMMAND_ABORT);
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

      return state?.state === dfuCommands.dfuERROR;
    } catch (_) {
      return true;
    }
  }

  getState() {
    return this.requestIn(DFU_COMMAND_GETSTATE, 1).then(
      (data) => Promise.resolve(data.getUint8(0)),
      (error) => Promise.reject("DFU GETSTATE failed: " + error)
    );
  }

  getStatus() {
    return this.requestIn(DFU_COMMAND_GETSTATUS, 6).then(
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
    return this.requestOut(DFU_COMMAND_CLRSTATUS);
  }

  // IDLE
  async abortToIdle() {
    await this.abort();
    let state = await this.getState();
    if (state === dfuCommands.dfuERROR) {
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
      return new Promise((resolve) => setTimeout(resolve, duration_ms));
    }

    while (!state_predicate(dfu_status.state) && dfu_status.state != dfuCommands.dfuERROR) {
      await async_sleep(dfu_status.pollTimeout);
      dfu_status = await this.getStatus();
    }

    return dfu_status;
  }

  poll_until_idle(idle_state: number) {
    return this.poll_until((state: number) => state === idle_state);
  }
}
