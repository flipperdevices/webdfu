import { WebDFUInterface } from "./index";

export const dfu: Record<string, number> = {
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

export function parseDeviceDescriptor(data) {
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

export function parseConfigurationDescriptor(data) {
  let descriptorData = new DataView(data.buffer.slice(9));
  let descriptors = parseSubDescriptors(descriptorData);

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

export function parseInterfaceDescriptor(data) {
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

export function parseFunctionalDescriptor(data) {
  return {
    bLength: data.getUint8(0),
    bDescriptorType: data.getUint8(1),
    bmAttributes: data.getUint8(2),
    wDetachTimeOut: data.getUint16(3, true),
    wTransferSize: data.getUint16(5, true),
    bcdDFUVersion: data.getUint16(7, true),
  };
}

export function parseSubDescriptors(descriptorData) {
  const DT_INTERFACE = 4;
  const DT_ENDPOINT = 5;
  const DT_DFU_FUNCTIONAL = 0x21;
  const USB_CLASS_APP_SPECIFIC = 0xfe;
  const USB_SUBCLASS_DFU = 0x01;
  let remainingData = descriptorData;
  let descriptors = [];
  let currIntf;
  let inDfuIntf = false;
  while (remainingData.byteLength > 2) {
    let bLength = remainingData.getUint8(0);
    let bDescriptorType = remainingData.getUint8(1);
    let descData = new DataView(remainingData.buffer.slice(0, bLength));
    if (bDescriptorType == DT_INTERFACE) {
      currIntf = parseInterfaceDescriptor(descData);
      if (currIntf.bInterfaceClass == USB_CLASS_APP_SPECIFIC && currIntf.bInterfaceSubClass == USB_SUBCLASS_DFU) {
        inDfuIntf = true;
      } else {
        inDfuIntf = false;
      }
      descriptors.push(currIntf);
    } else if (inDfuIntf && bDescriptorType == DT_DFU_FUNCTIONAL) {
      let funcDesc = parseFunctionalDescriptor(descData);
      descriptors.push(funcDesc);
      currIntf.descriptors.push(funcDesc);
    } else {
      let desc = {
        bLength: bLength,
        bDescriptorType: bDescriptorType,
        data: descData,
      };
      descriptors.push(desc);
      if (currIntf) {
        currIntf.descriptors.push(desc);
      }
    }
    remainingData = new DataView(remainingData.buffer.slice(bLength));
  }

  return descriptors;
}

export class DFU {
  disconnected: boolean;

  constructor(public device_: USBDevice, public settings: WebDFUInterface) {}

  get intfNumber(): number {
    return this.settings["interface"].interfaceNumber;
  }

  logDebug(msg) {}
  logInfo(msg) {}
  logWarning(msg) {}
  logError(msg) {}
  logProgress(done: number, total?: number) {}

  async open() {
    const confValue = this.settings.configuration.configurationValue;
    if (this.device_.configuration === null || this.device_.configuration.configurationValue != confValue) {
      await this.device_.selectConfiguration(confValue);
    }

    const intfNumber = this.settings["interface"].interfaceNumber;
    if (!this.device_.configuration.interfaces[intfNumber].claimed) {
      await this.device_.claimInterface(intfNumber);
    }

    const altSetting = this.settings.alternate.alternateSetting;
    let intf = this.device_.configuration.interfaces[intfNumber];
    if (intf.alternate === null || intf.alternate.alternateSetting != altSetting) {
      await this.device_.selectAlternateInterface(intfNumber, altSetting);
    }
  }

  requestOut(bRequest: number, data?: BufferSource, wValue = 0) {
    return this.device_
      .controlTransferOut(
        {
          requestType: "class",
          recipient: "interface",
          request: bRequest,
          value: wValue,
          index: this.intfNumber,
        },
        data
      )
      .then(
        (result) => {
          if (result.status == "ok") {
            return Promise.resolve(result.bytesWritten);
          } else {
            return Promise.reject(result.status);
          }
        },
        (error) => {
          return Promise.reject("ControlTransferOut failed: " + error);
        }
      );
  }

  requestIn(bRequest, wLength, wValue = 0) {
    return this.device_
      .controlTransferIn(
        {
          requestType: "class",
          recipient: "interface",
          request: bRequest,
          value: wValue,
          index: this.intfNumber,
        },
        wLength
      )
      .then(
        (result) => {
          if (result.status == "ok") {
            return Promise.resolve(result.data);
          } else {
            return Promise.reject(result.status);
          }
        },
        (error) => {
          return Promise.reject("ControlTransferIn failed: " + error);
        }
      );
  }

  detach() {
    return this.requestOut(dfu.DETACH, undefined, 1000);
  }

  async waitDisconnected(timeout) {
    let device = this;
    let usbDevice = this.device_;

    return new Promise((resolve, reject) => {
      let timeoutID;

      if (timeout > 0) {
        const onTimeout = () => {
          navigator.usb.removeEventListener("disconnect", onDisconnect);

          if (device.disconnected !== true) {
            reject("Disconnect timeout expired");
          }
        };

        timeoutID = setTimeout(onTimeout, timeout);
      }

      function onDisconnect(event) {
        if (event.device === usbDevice) {
          if (timeout > 0) {
            clearTimeout(timeoutID);
          }
          device.disconnected = true;
          navigator.usb.removeEventListener("disconnect", onDisconnect);
          event.stopPropagation();
          resolve(device);
        }
      }

      navigator.usb.addEventListener("disconnect", onDisconnect);
    });
  }

  download(data, blockNum) {
    return this.requestOut(dfu.DNLOAD, data, blockNum);
  }

  upload(length, blockNum) {
    return this.requestIn(dfu.UPLOAD, length, blockNum);
  }

  clearStatus() {
    return this.requestOut(dfu.CLRSTATUS);
  }

  getStatus() {
    return this.requestIn(dfu.GETSTATUS, 6).then(
      (data) =>
        Promise.resolve({
          status: data.getUint8(0),
          pollTimeout: data.getUint32(1, true) & 0xffffff,
          state: data.getUint8(4),
        }),
      (error) => Promise.reject("DFU GETSTATUS failed: " + error)
    );
  }

  getState() {
    return this.requestIn(dfu.GETSTATE, 1).then(
      (data) => Promise.resolve(data.getUint8(0)),
      (error) => Promise.reject("DFU GETSTATE failed: " + error)
    );
  }

  abort() {
    return this.requestOut(dfu.ABORT);
  }

  async abortToIdle() {
    await this.abort();
    let state = await this.getState();
    if (state == dfu.dfuERROR) {
      await this.clearStatus();
      state = await this.getState();
    }
    if (state != dfu.dfuIDLE) {
      throw "Failed to return to idle state after abort: state " + state;
    }
  }

  async do_upload(xfer_size, max_size = Infinity, first_block = 0) {
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
      this.logDebug("Read " + result.byteLength + " bytes");
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

  async poll_until(state_predicate) {
    let dfu_status = await this.getStatus();

    let device = this;

    function async_sleep(duration_ms) {
      return new Promise(function (resolve, reject) {
        device.logDebug("Sleeping for " + duration_ms + "ms");
        setTimeout(resolve, duration_ms);
      });
    }

    while (!state_predicate(dfu_status.state) && dfu_status.state != dfu.dfuERROR) {
      await async_sleep(dfu_status.pollTimeout);
      dfu_status = await this.getStatus();
    }

    return dfu_status;
  }

  poll_until_idle(idle_state) {
    return this.poll_until((state) => state == idle_state);
  }

  async do_download(xfer_size, data, manifestationTolerant) {
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
        this.logDebug("Sent " + bytes_written + " bytes");
        dfu_status = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
      } catch (error) {
        throw "Error during DFU download: " + error;
      }

      if (dfu_status.status != dfu.STATUS_OK) {
        throw `DFU DOWNLOAD failed state=${dfu_status.state}, status=${dfu_status.status}`;
      }

      this.logDebug("Wrote " + bytes_written + " bytes");
      bytes_sent += bytes_written;

      this.logProgress(bytes_sent, expected_size);
    }

    this.logDebug("Sending empty block");
    try {
      await this.download(new ArrayBuffer(0), transaction++);
    } catch (error) {
      throw "Error during final DFU download: " + error;
    }

    this.logInfo("Wrote " + bytes_sent + " bytes");
    this.logInfo("Manifesting new firmware");

    if (manifestationTolerant) {
      // Transition to MANIFEST_SYNC state
      let dfu_status;
      try {
        // Wait until it returns to idle.
        // If it's not really manifestation tolerant, it might transition to MANIFEST_WAIT_RESET
        dfu_status = await this.poll_until((state) => state == dfu.dfuIDLE || state == dfu.dfuMANIFEST_WAIT_RESET);
        if (dfu_status.state == dfu.dfuMANIFEST_WAIT_RESET) {
          this.logDebug("Device transitioned to MANIFEST_WAIT_RESET even though it is manifestation tolerant");
        }
        if (dfu_status.status != dfu.STATUS_OK) {
          throw `DFU MANIFEST failed state=${dfu_status.state}, status=${dfu_status.status}`;
        }
      } catch (error) {
        if (
          error.endsWith("ControlTransferIn failed: NotFoundError: Device unavailable.") ||
          error.endsWith("ControlTransferIn failed: NotFoundError: The device was disconnected.")
        ) {
          this.logWarning("Unable to poll final manifestation status");
        } else {
          throw "Error during DFU manifest: " + error;
        }
      }
    } else {
      // Try polling once to initiate manifestation
      try {
        let final_status = await this.getStatus();
        this.logDebug(`Final DFU status: state=${final_status.state}, status=${final_status.status}`);
      } catch (error) {
        this.logDebug("Manifest GET_STATUS poll error: " + error);
      }
    }

    // Reset to exit MANIFEST_WAIT_RESET
    try {
      await this.device_.reset();
    } catch (error) {
      if (
        error == "NetworkError: Unable to reset the device." ||
        error == "NotFoundError: Device unavailable." ||
        error == "NotFoundError: The device was disconnected."
      ) {
        this.logDebug("Ignored reset error");
      } else {
        throw "Error during reset for manifestation: " + error;
      }
    }

    return;
  }
}
