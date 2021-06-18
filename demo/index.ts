import { saveAs } from "file-saver";
import { WebDFUDriver, WebDFUType, WebDFU, DriverDFUse } from "./dfu/index";

import { clearLog, logError, logInfo, logProgress, logWarning, setLogContext } from "./log";
import { USB_PROTOCOL_DFU, USB_PROTOCOL_DFUSE } from "../core";

// Utils
function hex4(n: number) {
  let s = n.toString(16);

  while (s.length < 4) {
    s = "0" + s;
  }

  return s;
}

function hexAddr8(n: number) {
  let s = n.toString(16);
  while (s.length < 8) {
    s = "0" + s;
  }
  return "0x" + s;
}

function niceSize(n: number) {
  const gigabyte = 1024 * 1024 * 1024;
  const megabyte = 1024 * 1024;
  const kilobyte = 1024;
  if (n >= gigabyte) {
    return n / gigabyte + "GiB";
  } else if (n >= megabyte) {
    return n / megabyte + "MiB";
  } else if (n >= kilobyte) {
    return n / kilobyte + "KiB";
  } else {
    return n + "B";
  }
}

function formatDFUSummary(device: WebDFUDriver) {
  const vid = hex4(device.device.vendorId);
  const pid = hex4(device.device.productId);
  const name = device.device.productName;

  let mode = "Unknown";
  if (device.settings.alternate.interfaceProtocol === USB_PROTOCOL_DFU) {
    mode = "Runtime";
  } else if (device.settings.alternate.interfaceProtocol == USB_PROTOCOL_DFUSE) {
    mode = "DFU";
  }

  const cfg = device.settings.configuration.configurationValue;
  const intf = device.settings["interface"].interfaceNumber;
  const alt = device.settings.alternate.alternateSetting;
  const serial = device.device.serialNumber;

  return `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
}

// Current page
let webdfu: WebDFU | null = null;

const connectButton = document.querySelector("#connect") as HTMLButtonElement;
const writeButton = document.querySelector("#write") as HTMLButtonElement;
const readButton = document.querySelector("#read") as HTMLButtonElement;
const statusDisplay = document.querySelector("#status") as HTMLDivElement;
const infoDisplay = document.querySelector("#usbInfo") as HTMLDivElement;
const dfuDisplay = document.querySelector("#dfuInfo") as HTMLDivElement;

const configForm = document.querySelector("#configForm") as HTMLFormElement;

const transferSizeField = document.querySelector("#transferSize") as HTMLInputElement;
let transferSize = parseInt(transferSizeField.value);

const dfuseStartAddressField = document.querySelector("#dfuseStartAddress") as HTMLInputElement;
const dfuseReadSizeField = document.querySelector("#dfuseReadSize") as HTMLInputElement;

const firmwareFileField = document.querySelector("#firmwareFile") as HTMLInputElement;
let firmwareFile: ArrayBuffer | null = null;

const writeLog = document.querySelector("#writeLog") as HTMLDivElement;
const readLog = document.querySelector("#readLog") as HTMLDivElement;

let manifestationTolerant = true;

function onDisconnect(reason?: Error) {
  if (reason) {
    statusDisplay.textContent = reason.message;
  }

  connectButton.textContent = "Connect";
  infoDisplay.textContent = "";
  dfuDisplay.textContent = "";
  readButton.disabled = false;
  writeButton.disabled = true;
  firmwareFileField.disabled = true;
}

function onUnexpectedDisconnect(event: USBConnectionEvent) {
  if (webdfu?.device) {
    if (webdfu?.device === event.device) {
      onDisconnect(new Error("Device disconnected"));
      webdfu = null;
    }
  }
}

async function connect(interfaceIndex: number) {
  if (!webdfu) {
    throw new Error();
  }

  await webdfu.connect(interfaceIndex);

  if (!webdfu.driver) {
    throw new Error();
  }

  let memorySummary = "";
  if (webdfu.properties) {
    const desc = webdfu.properties;

    const info = [
      `WillDetach=${webdfu.properties.WillDetach}`,
      `ManifestationTolerant=${webdfu.properties.ManifestationTolerant}`,
      `CanRead=${webdfu.properties.CanRead}`,
      `CanWrite=${webdfu.properties.CanWrite}`,
      `TransferSize=${webdfu.properties.TransferSize}`,
      `DetachTimeOut=${webdfu.properties.DetachTimeOut}`,
      `Version=${hex4(webdfu.properties.DFUVersion)}`,
    ];

    dfuDisplay.textContent += "\n" + info.join(", ");
    transferSizeField.value = webdfu.properties.TransferSize.toString();
    transferSize = webdfu.properties.TransferSize;

    if (webdfu.properties.CanWrite) {
      manifestationTolerant = webdfu.properties.ManifestationTolerant;
    }

    if (webdfu.driver.settings.alternate.interfaceProtocol == 0x02) {
      if (!desc.CanRead) {
        readButton.disabled = false;
        dfuseReadSizeField.disabled = true;
      }

      if (!desc.CanWrite) {
        writeButton.disabled = true;
      }
    }

    console.log(WebDFUType);
    if (webdfu.type === WebDFUType.SDFUse && webdfu.driver instanceof DriverDFUse) {
      if (webdfu.driver.memoryInfo) {
        let totalSize = 0;
        for (const segment of webdfu.driver.memoryInfo.segments) {
          totalSize += segment.end - segment.start;
        }
        memorySummary = `Selected memory region: ${webdfu.driver.memoryInfo.name} (${niceSize(totalSize)})`;
        for (const segment of webdfu.driver.memoryInfo.segments) {
          const properties = [];
          if (segment.readable) {
            properties.push("readable");
          }
          if (segment.erasable) {
            properties.push("erasable");
          }
          if (segment.writable) {
            properties.push("writable");
          }
          let propertySummary = properties.join(", ");
          if (!propertySummary) {
            propertySummary = "inaccessible";
          }

          memorySummary += `\n${hexAddr8(segment.start)}-${hexAddr8(segment.end - 1)} (${propertySummary})`;
        }
      }
    }
  }

  // Clear logs
  clearLog(readLog);
  clearLog(writeLog);

  // Display basic USB information
  statusDisplay.textContent = "";
  connectButton.textContent = "Disconnect";
  infoDisplay.textContent =
    `Name: ${webdfu.driver.device.productName}\n` +
    `MFG: ${webdfu.driver.device.manufacturerName}\n` +
    `Serial: ${webdfu.driver.device.serialNumber}\n`;

  // Display basic dfu-util style info
  if (webdfu.driver) {
    dfuDisplay.textContent = formatDFUSummary(webdfu.driver) + "\n" + memorySummary;
  } else {
    dfuDisplay.textContent = "Not found";
  }

  // Update buttons based on capabilities
  if (webdfu.driver?.settings.alternate.interfaceProtocol == 0x01) {
    // Runtime
    readButton.disabled = false;
    writeButton.disabled = true;
    firmwareFileField.disabled = true;
  } else {
    // DFU
    readButton.disabled = false;
    writeButton.disabled = false;
    firmwareFileField.disabled = false;
  }

  if (webdfu.driver instanceof DriverDFUse && webdfu.driver.memoryInfo) {
    const dfuseFieldsDiv = document.querySelector("#dfuseFields") as HTMLDivElement;
    dfuseFieldsDiv.hidden = false;
    dfuseStartAddressField.disabled = false;
    dfuseReadSizeField.disabled = false;
    const segment = webdfu.driver.getFirstWritableSegment();
    if (segment) {
      webdfu.driver.startAddress = segment.start;
      dfuseStartAddressField.value = "0x" + segment.start.toString(16);
      const maxReadSize = webdfu.driver.getMaxReadSize(segment.start);
      dfuseReadSizeField.value = maxReadSize.toString();
      dfuseReadSizeField.max = maxReadSize.toString();
    }
  } else {
    const dfuseFieldsDiv = document.querySelector("#dfuseFields") as HTMLDivElement;
    dfuseFieldsDiv.hidden = true;
    dfuseStartAddressField.disabled = true;
    dfuseReadSizeField.disabled = true;
  }

  return webdfu.driver;
}

transferSizeField.addEventListener("change", () => {
  transferSize = parseInt(transferSizeField.value);
});

dfuseStartAddressField.addEventListener("change", function (event) {
  const field = event.target as HTMLInputElement;
  const address = parseInt(field.value, 16);
  if (isNaN(address)) {
    field.setCustomValidity("Invalid hexadecimal start address");
  } else if (webdfu?.driver && webdfu.driver instanceof DriverDFUse && webdfu?.driver?.memoryInfo) {
    if (webdfu?.driver.getSegment(address) !== null) {
      webdfu.driver.startAddress = address;
      field.setCustomValidity("");
      if (webdfu?.driver && webdfu?.driver instanceof DriverDFUse) {
        dfuseReadSizeField.max = webdfu.driver.getMaxReadSize(address).toString();
      }
    } else {
      field.setCustomValidity("Address outside of memory map");
    }
  } else {
    field.setCustomValidity("");
  }
});

connectButton.addEventListener("click", function () {
  if (webdfu) {
    webdfu.close().catch(console.error);
    webdfu = null;

    return;
  }

  navigator.usb
    .requestDevice({ filters: [] })
    .then(async (selectedDevice) => {
      webdfu = new WebDFU(
        selectedDevice,
        {
          forceInterfacesName: true,
        },
        {
          info: logInfo,
          warning: logWarning,
          error: logError,
          progress: logProgress,
        }
      );
      webdfu.events.on("disconnect", onDisconnect);

      await webdfu.init();

      if (webdfu.interfaces.length == 0) {
        statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
        return;
      }

      await connect(0);
    })
    .catch((error) => {
      console.log(error);
      statusDisplay.textContent = error;
    });
});

readButton.addEventListener("click", async function (event) {
  event.preventDefault();
  event.stopPropagation();
  if (!configForm.checkValidity()) {
    configForm.reportValidity();
    return false;
  }

  if (!webdfu?.driver || !webdfu?.driver.device.opened) {
    onDisconnect();
    webdfu = null;
  } else {
    setLogContext(readLog);
    clearLog(readLog);
    try {
      if (await webdfu?.driver?.isError()) {
        await webdfu?.driver.clearStatus();
      }
    } catch (error) {
      webdfu?.driver.logWarning("Failed to clear status");
    }

    let maxSize = Infinity;
    if (!dfuseReadSizeField.disabled) {
      maxSize = parseInt(dfuseReadSizeField.value);
    }

    try {
      const blob = await webdfu?.driver.do_read(transferSize, maxSize);

      saveAs(blob, "firmware.bin");
    } catch (error) {
      logError(error);
    }

    setLogContext(null);
  }

  return false;
});

firmwareFileField.addEventListener("change", function () {
  firmwareFile = null;
  if ((firmwareFileField?.files ?? []).length > 0) {
    const file = firmwareFileField.files?.[0] as Blob;
    const reader = new FileReader();
    reader.onload = function () {
      if (reader.result instanceof ArrayBuffer) {
        firmwareFile = reader.result;
      }
    };
    reader.readAsArrayBuffer(file);
  }
});

async function write(): Promise<void> {
  if (!configForm.checkValidity()) {
    configForm.reportValidity();
    return;
  }

  if (webdfu?.driver && firmwareFile != null) {
    setLogContext(writeLog);
    clearLog(writeLog);

    try {
      if (await webdfu?.driver?.isError()) {
        await webdfu?.driver.clearStatus();
      }
    } catch (error) {
      webdfu?.driver.logWarning("Failed to clear status");
    }

    try {
      await webdfu?.driver.do_write(transferSize, firmwareFile, manifestationTolerant);

      logInfo("Done!");
      setLogContext(null);

      if (!manifestationTolerant) {
        try {
          await webdfu?.driver.waitDisconnected(5000);

          onDisconnect();
          webdfu = null;
        } catch (error) {
          // It didn't reset and disconnect for some reason...
          console.log("Device unexpectedly tolerated manifestation.");
        }
      }
    } catch (error) {
      logError(error);
      setLogContext(null);
    }
  }
}

writeButton.addEventListener("click", async function (event) {
  event.preventDefault();
  event.stopPropagation();

  write().catch(console.error);
});

if (typeof navigator.usb === "undefined") {
  statusDisplay.textContent = "WebUSB not available.";
  connectButton.disabled = true;
} else {
  navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
}
