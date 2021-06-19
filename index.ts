import { createNanoEvents } from "nanoevents";

import {
  WebDFUInterfaceDescriptor,
  WebDFUInterfaceSubDescriptor,
  WebDFULog,
  WebDFUOptions,
  WebDFUProperties,
  WebDFUSettings,
  WebDFUType,
} from "./types";
import { WebDFUDriver } from "./base.driver";
import { DriverDFU } from "./dfu.driver";
import { DriverDFUse } from "./dfuse.driver";
import { checkDFUInterface, parseConfigurationDescriptor, WebDFUDriverType, WebDFUError } from "./core";

export * from "./types";
export * from "./base.driver";
export * from "./dfu.driver";
export * from "./dfuse.driver";

export type WebDFUEvent = {
  init: () => void;
  connect: () => void;
  disconnect: (error?: Error) => void;
};

export class WebDFU {
  events = createNanoEvents<WebDFUEvent>();

  driver?: WebDFUDriver;
  interfaces: WebDFUSettings[] = [];
  properties?: WebDFUProperties;

  constructor(
    public readonly device: USBDevice,
    public readonly settings: WebDFUOptions = {},
    private readonly log?: WebDFULog
  ) {}

  /**
   * Return the current driver type
   */
  get type(): WebDFUDriverType {
    if (this.properties?.DFUVersion == 0x011a && this.driver?.settings.alternate.interfaceProtocol == 0x02) {
      return WebDFUDriverType.DfuSe;
    }

    return WebDFUDriverType.Dfu;
  }

  async init(): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }

    this.interfaces = await this.findDfuInterfaces();

    this.events.emit("init");
  }

  async connect(interfaceIndex: number): Promise<void> {
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

    this.driver = new DriverDFU(this.device, intrf, this.log);

    if (desc) {
      this.properties = desc;

      if (this.type === WebDFUType.SDFUse) {
        this.driver = new DriverDFUse(this.device, intrf, this.log);
      }
    }

    try {
      await this.driver.open();
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

  async read(xfer_size: number, max_size: number) {
    return this.driver?.do_read(xfer_size, max_size);
  }

  write(xfer_size: number, data: ArrayBuffer, manifestationTolerant: boolean) {
    return this.driver?.do_write(xfer_size, data, manifestationTolerant);
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
      CanWrite: (funcDesc.bmAttributes & 0x01) != 0,
      CanRead: (funcDesc.bmAttributes & 0x02) != 0,
      ManifestationTolerant: (funcDesc.bmAttributes & 0x04) != 0,
      WillDetach: (funcDesc.bmAttributes & 0x08) != 0,
      TransferSize: funcDesc.wTransferSize,
      DetachTimeOut: funcDesc.wDetachTimeOut,
      DFUVersion: funcDesc.bcdDFUVersion,
    };
  }

  private async findDfuInterfaces(): Promise<WebDFUSettings[]> {
    const interfaces = [];
    let forceInterfaceMameMapping = null;

    for (let configuration of this.device.configurations) {
      for (let intf of configuration.interfaces) {
        for (let alternate of intf.alternates) {
          if (checkDFUInterface(alternate)) {
            let name = alternate.interfaceName;

            if (!name && this.settings.forceInterfacesName) {
              if (!forceInterfaceMameMapping) {
                await this.device.open();
                await this.device.selectConfiguration(1);

                forceInterfaceMameMapping = await this.readInterfaceNames();
              }

              let configIndex = configuration.configurationValue;
              let intfNumber = intf.interfaceNumber;
              let alt = alternate.alternateSetting;

              name = forceInterfaceMameMapping[configIndex]?.[intfNumber]?.[alt]?.toString();
            }

            interfaces.push({
              name,
              configuration,
              interface: intf,
              alternate: alternate,
            });
          }
        }
      }
    }

    return interfaces;
  }

  async readInterfaceNames() {
    const DT_INTERFACE = 4;

    let configs: Record<number, Record<number, Record<number, number>>> = {};
    let allStringIndices = new Set<any>();

    for (let configIndex = 0; configIndex < this.device.configurations.length; configIndex++) {
      const configDesc = parseConfigurationDescriptor(await this.readConfigurationDescriptor(configIndex));
      const configValue = configDesc.bConfigurationValue;

      configs[configValue] = {};

      // Retrieve string indices for interface names
      for (let desc of configDesc.descriptors as WebDFUInterfaceDescriptor[]) {
        if (desc.bDescriptorType === DT_INTERFACE) {
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

  async readDeviceDescriptor(): Promise<DataView> {
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

  async readStringDescriptor(index: number, langID = 0) {
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
        if (!langID) {
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

  async readConfigurationDescriptor(index: number): Promise<DataView> {
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
}
