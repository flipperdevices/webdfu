import { createNanoEvents } from "nanoevents";
import { DFU, parseConfigurationDescriptor } from "./dfu";
import { DFUse } from "./dfuse";

export type WebDFUInterface = {
  name?: string;
  configuration: USBConfiguration;
  interface: USBInterface;
  alternate: USBAlternateInterface;
};

export type WebDFUEvent = {
  init: () => void;
  connect: () => void;
  disconnect: (error?: Error) => void;
};

export type WebDFUOptions = {
  forceInterfacesName?: boolean;
};

export type WebDFUProperties = {
  WillDetach: boolean;
  ManifestationTolerant: boolean;
  CanUpload: boolean;
  CanDnload: boolean;
  TransferSize: number;
  DetachTimeOut: number;
  DFUVersion: number;
};

export enum WebDFUType {
  DFU = 1,
  SDFUse,
}

export class WebDFU {
  events = createNanoEvents<WebDFUEvent>();

  interfaces: WebDFUInterface[] = [];
  dfu?: DFU | DFUse;
  properties?: WebDFUProperties;

  constructor(public readonly device: USBDevice, public readonly settings: WebDFUOptions = {}) {}

  get type(): WebDFUType {
    if (this.properties?.DFUVersion == 0x011a && this.dfu?.settings.alternate.interfaceProtocol == 0x02) {
      return WebDFUType.SDFUse;
    }

    return WebDFUType.DFU;
  }

  async init() {
    this.interfaces = await this.findDfuInterfaces();

    this.events.emit("init");
  }

  async connect(interfaceIndex: number) {
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

    this.dfu = new DFU(this.device, this.interfaces[interfaceIndex]);

    if (desc) {
      this.properties = desc;

      if (this.type === WebDFUType.SDFUse) {
        this.dfu = new DFUse(this.device, this.interfaces[interfaceIndex]);
      }
    }

    try {
      await this.dfu.open();
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

  // Attempt to read the DFU functional descriptor
  // TODO: read the selected configuration's descriptor
  private async getDFUDescriptorProperties(): Promise<WebDFUProperties | null> {
    const data = await this.readConfigurationDescriptor(0);

    let configDesc = parseConfigurationDescriptor(data);
    let funcDesc = null;
    let configValue = this.device.configuration?.configurationValue;
    if (configDesc.bConfigurationValue == configValue) {
      for (let desc of configDesc.descriptors) {
        if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty("bcdDFUVersion")) {
          funcDesc = desc;
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
      CanDnload: (funcDesc.bmAttributes & 0x01) != 0,
      TransferSize: funcDesc.wTransferSize,
      DetachTimeOut: funcDesc.wDetachTimeOut,
      DFUVersion: funcDesc.bcdDFUVersion,
    };
  }

  private async findDfuInterfaces(): Promise<WebDFUInterface[]> {
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

  private async fixInterfaceNames(interfaces) {
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
          intf.name = mapping[configIndex][intfNumber][alt];
        }
      }
    }
  }

  async readStringDescriptor(index, langID = 0) {
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

    throw `Failed to read string descriptor ${index}: ${result.status}`;
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
      throw `Failed to read device descriptor: ${result.status}`;
    }

    return result.data;
  }

  async readInterfaceNames() {
    const DT_INTERFACE = 4;

    let configs = {};
    let allStringIndices = new Set();
    for (let configIndex = 0; configIndex < this.device.configurations.length; configIndex++) {
      const rawConfig = await this.readConfigurationDescriptor(configIndex);
      let configDesc = parseConfigurationDescriptor(rawConfig);
      let configValue = configDesc.bConfigurationValue;
      configs[configValue] = {};

      // Retrieve string indices for interface names
      for (let desc of configDesc.descriptors) {
        if (desc.bDescriptorType == DT_INTERFACE) {
          if (!(desc.bInterfaceNumber in configs[configValue])) {
            configs[configValue][desc.bInterfaceNumber] = {};
          }
          configs[configValue][desc.bInterfaceNumber][desc.bAlternateSetting] = desc.iInterface;
          if (desc.iInterface > 0) {
            allStringIndices.add(desc.iInterface);
          }
        }
      }
    }

    let strings = {};
    // Retrieve interface name strings
    for (let index of allStringIndices) {
      try {
        strings[index] = await this.readStringDescriptor(index, 0x0409);
      } catch (error) {
        console.log(error);
        strings[index] = null;
      }
    }

    for (let configValue in configs) {
      for (let intfNumber in configs[configValue]) {
        for (let alt in configs[configValue][intfNumber]) {
          const iIndex = configs[configValue][intfNumber][alt];
          configs[configValue][intfNumber][alt] = strings[iIndex];
        }
      }
    }

    return configs;
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
      throw new Error(`controlTransferIn error. [status]: ${descriptorSize.status}`);
    }

    // Read out length of the configuration descriptor
    let wLength = descriptorSize.data.getUint16(2, true);

    const descriptor = await this.device.controlTransferIn(setup, wLength);

    if (!descriptor.data || descriptor.status !== "ok") {
      throw new Error(`controlTransferIn error. [status]: ${descriptor.status}`);
    }

    return descriptor.data;
  }
}

export * from "./dfu.ts";
export * from "./dfuse.ts";
