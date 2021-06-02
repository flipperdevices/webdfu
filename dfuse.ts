import { dfu, DFU } from "./dfu";

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

export class DFUse extends DFU {
  startAddress: number = NaN;
  memoryInfo?: { name: string; segments: DFUseMemorySegment[] };

  constructor(...args) {
    super(...args);

    if (this.settings.name) {
      this.memoryInfo = this.parseMemoryDescriptor(this.settings.name);
    }
  }

  parseMemoryDescriptor(desc): { name: string; segments: DFUseMemorySegment[] } {
    const nameEndIndex = desc.indexOf("/");
    if (!desc.startsWith("@") || nameEndIndex == -1) {
      throw `Not a DfuSe memory descriptor: "${desc}"`;
    }

    const name = desc.substring(1, nameEndIndex).trim();
    const segmentString = desc.substring(nameEndIndex);

    let segments = [];

    const sectorMultipliers = {
      " ": 1,
      B: 1,
      K: 1024,
      M: 1048576,
    };

    let contiguousSegmentRegex =
      /\/\s*(0x[0-9a-fA-F]{1,8})\s*\/(\s*[0-9]+\s*\*\s*[0-9]+\s?[ BKM]\s*[abcdefg]\s*,?\s*)+/g;
    let contiguousSegmentMatch;
    while ((contiguousSegmentMatch = contiguousSegmentRegex.exec(segmentString))) {
      let segmentRegex = /([0-9]+)\s*\*\s*([0-9]+)\s?([ BKM])\s*([abcdefg])\s*,?\s*/g;
      let startAddress = parseInt(contiguousSegmentMatch[1], 16);
      let segmentMatch;
      while ((segmentMatch = segmentRegex.exec(contiguousSegmentMatch[0]))) {
        let sectorCount = parseInt(segmentMatch[1], 10);
        let sectorSize = parseInt(segmentMatch[2]) * sectorMultipliers[segmentMatch[3]];
        let properties = segmentMatch[4].charCodeAt(0) - "a".charCodeAt(0) + 1;

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

  async dfuseCommand(command, param, len) {
    if (typeof param === "undefined" && typeof len === "undefined") {
      param = 0x00;
      len = 1;
    }

    const commandNames = {
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
      throw "Don't know how to handle data of len " + len;
    }

    try {
      await this.download(payload, 0);
    } catch (error) {
      throw "Error during special DfuSe command " + commandNames[command] + ":" + error;
    }

    let status = await this.poll_until((state) => state != dfu.dfuDNBUSY);

    if (status.status != dfu.STATUS_OK) {
      throw "Special DfuSe command " + command + " failed";
    }
  }

  getSegment(addr) {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw "No memory map information available";
    }

    for (let segment of this.memoryInfo.segments) {
      if (segment.start <= addr && addr < segment.end) {
        return segment;
      }
    }

    return null;
  }

  getSectorStart(addr, segment) {
    if (typeof segment === "undefined") {
      segment = this.getSegment(addr);
    }

    if (!segment) {
      throw `Address ${addr.toString(16)} outside of memory map`;
    }

    const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
    return segment.start + sectorIndex * segment.sectorSize;
  }

  getSectorEnd(addr, segment) {
    if (typeof segment === "undefined") {
      segment = this.getSegment(addr);
    }

    if (!segment) {
      throw `Address ${addr.toString(16)} outside of memory map`;
    }

    const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
    return segment.start + (sectorIndex + 1) * segment.sectorSize;
  }

  getFirstWritableSegment() {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw "No memory map information available";
    }

    for (let segment of this.memoryInfo.segments) {
      if (segment.writable) {
        return segment;
      }
    }

    return null;
  }

  getMaxReadSize(startAddr) {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw "No memory map information available";
    }

    let numBytes = 0;
    for (let segment of this.memoryInfo.segments) {
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

  async erase(startAddr, length) {
    let segment = this.getSegment(startAddr);
    let addr = this.getSectorStart(startAddr, segment);
    const endAddr = this.getSectorEnd(startAddr + length - 1);

    let bytesErased = 0;
    const bytesToErase = endAddr - addr;
    if (bytesToErase > 0) {
      this.logProgress(bytesErased, bytesToErase);
    }

    while (addr < endAddr) {
      if (segment.end <= addr) {
        segment = this.getSegment(addr);
      }
      if (!segment.erasable) {
        // Skip over the non-erasable section
        bytesErased = Math.min(bytesErased + segment.end - addr, bytesToErase);
        addr = segment.end;
        this.logProgress(bytesErased, bytesToErase);
        continue;
      }
      const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
      const sectorAddr = segment.start + sectorIndex * segment.sectorSize;
      this.logDebug(`Erasing ${segment.sectorSize}B at 0x${sectorAddr.toString(16)}`);
      await this.dfuseCommand(DFUseCommands.ERASE_SECTOR, sectorAddr, 4);
      addr = sectorAddr + segment.sectorSize;
      bytesErased += segment.sectorSize;
      this.logProgress(bytesErased, bytesToErase);
    }
  }

  async do_download(xfer_size, data, manifestationTolerant) {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw "No memory map available";
    }

    this.logInfo("Erasing DFU device memory");

    let bytes_sent = 0;
    let expected_size = data.byteLength;

    let startAddress = this.startAddress;
    if (isNaN(startAddress)) {
      startAddress = this.memoryInfo.segments[0].start;
      this.logWarning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getSegment(startAddress) === null) {
      this.logError(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
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
        this.logDebug(`Set address to 0x${address.toString(16)}`);
        bytes_written = await this.download(data.slice(bytes_sent, bytes_sent + chunk_size), 2);
        this.logDebug("Sent " + bytes_written + " bytes");
        dfu_status = await this.poll_until_idle(dfu.dfuDNLOAD_IDLE);
        address += chunk_size;
      } catch (error) {
        throw "Error during DfuSe download: " + error;
      }

      if (dfu_status.status != dfu.STATUS_OK) {
        throw `DFU DOWNLOAD failed state=${dfu_status.state}, status=${dfu_status.status}`;
      }

      this.logDebug("Wrote " + bytes_written + " bytes");
      bytes_sent += bytes_written;

      this.logProgress(bytes_sent, expected_size);
    }
    this.logInfo(`Wrote ${bytes_sent} bytes`);

    this.logInfo("Manifesting new firmware");
    try {
      await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
      await this.download(new ArrayBuffer(0), 0);
    } catch (error) {
      throw "Error during DfuSe manifestation: " + error;
    }

    try {
      await this.poll_until((state) => state == dfu.dfuMANIFEST);
    } catch (error) {
      this.logError(error);
    }
  }

  async do_upload(xfer_size, max_size) {
    let startAddress = this.startAddress;
    if (isNaN(startAddress)) {
      startAddress = this.memoryInfo.segments[0].start;
      this.logWarning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getSegment(startAddress) === null) {
      this.logWarning(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }

    this.logInfo(`Reading up to 0x${max_size.toString(16)} bytes starting at 0x${startAddress.toString(16)}`);
    let state = await this.getState();
    if (state != dfu.dfuIDLE) {
      await this.abortToIdle();
    }
    await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
    await this.abortToIdle();

    // DfuSe encodes the read address based on the transfer size,
    // the block number - 2, and the SET_ADDRESS pointer.
    return await super.do_upload(xfer_size, max_size, 2);
  }
}
