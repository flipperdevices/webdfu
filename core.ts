export type DFUseMemorySegment = {
  start: number;
  end: number;
  sectorSize: number;

  readable: boolean;
  erasable: boolean;
  writable: boolean;
};

export enum DFUseCommands {
  GET_COMMANDS = 0x00,
  SET_ADDRESS = 0x21,
  ERASE_SECTOR = 0x41,
}

export type WebDFUSettings = {
  name?: string;
  configuration: USBConfiguration;
  interface: USBInterface;
  alternate: USBAlternateInterface;
};

export type WebDFUDeviceDescriptor = {
  bLength: number;
  bDescriptorType: number;
  bcdUSB: number;
  bDeviceClass: number;
  bDeviceSubClass: number;
  bDeviceProtocol: number;
  bMaxPacketSize: number;
  idVendor: number;
  idProduct: number;
  bcdDevice: number;
  iManufacturer: number;
  iProduct: number;
  iSerialNumber: number;
  bNumConfigurations: number;
};

export type WebDFUFunctionalDescriptor = {
  bLength: number;
  bDescriptorType: number;
  bmAttributes: number;
  wDetachTimeOut: number;
  wTransferSize: number;
  bcdDFUVersion: number;
};

export type WebDFUInterfaceDescriptor = {
  bLength: number;
  bDescriptorType: number;
  bInterfaceNumber: number;
  bAlternateSetting: number;
  bNumEndpoints: number;
  bInterfaceClass: number;
  bInterfaceSubClass: number;
  bInterfaceProtocol: number;
  iInterface: number;
  descriptors: (WebDFUFunctionalDescriptor | WebDFUInterfaceSubDescriptor)[];
};

export type WebDFUInterfaceSubDescriptor = {
  descData: DataView;
  bLength: number;
  bDescriptorType: number;
  bmAttributes: number;
  wDetachTimeOut: number;
  wTransferSize: number;
  bcdDFUVersion: number;
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
  CanDownload: boolean;
  TransferSize: number;
  DetachTimeOut: number;
  DFUVersion: number;
};

export type WebDFULog = Record<"info" | "warning", (msg: string) => void> & {
  progress: (done: number, total?: number) => void;
};

export const WebDFUType: Record<"DFU" | "SDFUse", number> = {
  DFU: 1,
  SDFUse: 2,
};

export class WebDFUError extends Error {}

// Parse descriptors
export function parseMemoryDescriptor(desc: string): { name: string; segments: DFUseMemorySegment[] } {
  const nameEndIndex = desc.indexOf("/");
  if (!desc.startsWith("@") || nameEndIndex == -1) {
    throw new WebDFUError(`Not a DfuSe memory descriptor: "${desc}"`);
  }

  const name = desc.substring(1, nameEndIndex).trim();
  const segmentString = desc.substring(nameEndIndex);

  let segments = [];

  const sectorMultipliers: Record<string, number> = {
    " ": 1,
    B: 1,
    K: 1024,
    M: 1048576,
  };

  let contiguousSegmentRegex = /\/\s*(0x[0-9a-fA-F]{1,8})\s*\/(\s*[0-9]+\s*\*\s*[0-9]+\s?[ BKM]\s*[abcdefg]\s*,?\s*)+/g;
  let contiguousSegmentMatch: RegExpExecArray | null;
  while ((contiguousSegmentMatch = contiguousSegmentRegex.exec(segmentString))) {
    let segmentRegex = /([0-9]+)\s*\*\s*([0-9]+)\s?([ BKM])\s*([abcdefg])\s*,?\s*/g;
    let startAddress = parseInt(contiguousSegmentMatch?.[1] ?? "", 16);
    let segmentMatch: RegExpExecArray | null;
    while ((segmentMatch = segmentRegex.exec(contiguousSegmentMatch[0]!))) {
      let sectorCount = parseInt(segmentMatch[1]!, 10);
      let sectorSize = parseInt(segmentMatch[2]!) * (sectorMultipliers[segmentMatch?.[3] ?? ""] ?? 0);
      let properties = (segmentMatch?.[4] ?? "")?.charCodeAt(0) - "a".charCodeAt(0) + 1;

      let segment = {
        start: startAddress,
        sectorSize: sectorSize,
        end: startAddress + sectorSize * sectorCount,
        readable: (properties & 0x1) != 0,
        erasable: (properties & 0x2) != 0,
        writable: (properties & 0x4) != 0,
      };

      segments.push(segment);

      startAddress += sectorSize * sectorCount;
    }
  }

  return { name, segments };
}

export function parseDeviceDescriptor(data: DataView): WebDFUDeviceDescriptor {
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

export function parseFunctionalDescriptor(data: DataView): WebDFUFunctionalDescriptor {
  return {
    bLength: data.getUint8(0),
    bDescriptorType: data.getUint8(1),
    bmAttributes: data.getUint8(2),
    wDetachTimeOut: data.getUint16(3, true),
    wTransferSize: data.getUint16(5, true),
    bcdDFUVersion: data.getUint16(7, true),
  };
}

export function parseInterfaceDescriptor(data: DataView): WebDFUInterfaceDescriptor {
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

export function parseSubDescriptors(descriptorData: DataView) {
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

export function parseConfigurationDescriptor(data: DataView) {
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
