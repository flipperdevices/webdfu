import { saveAs } from "file-saver";
import { WebDFUType, WebDFU } from "dfu";

import { clearLog, logError, logInfo, logProgress, logWarning, setLogContext } from "./log";

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

function formatDFUSummary(device: WebDFU) {
  const vid = hex4(device.device.vendorId);
  const pid = hex4(device.device.productId);
  const name = device.device.productName;

  let mode = "Unknown";
  if (device.currentInterfaceSettings?.alternate.interfaceProtocol == 0x01) {
    mode = "Runtime";
  } else if (device.currentInterfaceSettings?.alternate.interfaceProtocol == 0x02) {
    mode = "DFU";
  }

  const cfg = device.currentInterfaceSettings?.configuration.configurationValue;
  const intf = device.currentInterfaceSettings?.["interface"].interfaceNumber;
  const alt = device.currentInterfaceSettings?.alternate.alternateSetting;
  const serial = device.device.serialNumber;

  return `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
}

// Current page
let webdfu: WebDFU | null = null;

const connectButton = document.querySelector("#connect") as HTMLButtonElement;
const downloadButton = document.querySelector("#download") as HTMLButtonElement;
const uploadButton = document.querySelector("#upload") as HTMLButtonElement;
const statusDisplay = document.querySelector("#status") as HTMLDivElement;
const infoDisplay = document.querySelector("#usbInfo") as HTMLDivElement;
const dfuDisplay = document.querySelector("#dfuInfo") as HTMLDivElement;

const configForm = document.querySelector("#configForm") as HTMLFormElement;

const transferSizeField = document.querySelector("#transferSize") as HTMLInputElement;
let transferSize = parseInt(transferSizeField.value);

const dfuseStartAddressField = document.querySelector("#dfuseStartAddress") as HTMLInputElement;
const dfuseUploadSizeField = document.querySelector("#dfuseUploadSize") as HTMLInputElement;

const firmwareFileField = document.querySelector("#firmwareFile") as HTMLInputElement;
let firmwareFile: ArrayBuffer | null = null;

const downloadLog = document.querySelector("#downloadLog") as HTMLDivElement;
const uploadLog = document.querySelector("#uploadLog") as HTMLDivElement;

let manifestationTolerant = true;

function onDisconnect(reason?: Error) {
  if (reason) {
    statusDisplay.textContent = reason.message;
  }

  connectButton.textContent = "Connect";
  infoDisplay.textContent = "";
  dfuDisplay.textContent = "";
  uploadButton.disabled = false;
  downloadButton.disabled = true;
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

  let memorySummary = "";
  if (webdfu.properties) {
    const desc = webdfu.properties;

    const info = [
      `WillDetach=${webdfu.properties.WillDetach}`,
      `ManifestationTolerant=${webdfu.properties.ManifestationTolerant}`,
      `CanUpload=${webdfu.properties.CanUpload}`,
      `CanDownload=${webdfu.properties.CanDownload}`,
      `TransferSize=${webdfu.properties.TransferSize}`,
      `DetachTimeOut=${webdfu.properties.DetachTimeOut}`,
      `Version=${hex4(webdfu.properties.DFUVersion)}`,
    ];

    dfuDisplay.textContent += "\n" + info.join(", ");
    transferSizeField.value = webdfu.properties.TransferSize.toString();
    transferSize = webdfu.properties.TransferSize;

    if (webdfu.properties.CanDownload) {
      manifestationTolerant = webdfu.properties.ManifestationTolerant;
    }

    if (webdfu.currentInterfaceSettings?.alternate.interfaceProtocol == 0x02) {
      if (!desc.CanUpload) {
        uploadButton.disabled = false;
        dfuseUploadSizeField.disabled = true;
      }

      if (!desc.CanDownload) {
        downloadButton.disabled = true;
      }
    }

    if (webdfu.type === WebDFUType.SDFUse) {
      if (webdfu.dfuseMemoryInfo) {
        let totalSize = 0;
        for (const segment of webdfu.dfuseMemoryInfo.segments) {
          totalSize += segment.end - segment.start;
        }
        memorySummary = `Selected memory region: ${webdfu.dfuseMemoryInfo.name} (${niceSize(totalSize)})`;
        for (const segment of webdfu.dfuseMemoryInfo.segments) {
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
  clearLog(uploadLog);
  clearLog(downloadLog);

  // Display basic USB information
  statusDisplay.textContent = "";
  connectButton.textContent = "Disconnect";
  infoDisplay.textContent =
    `Name: ${webdfu.device.productName}\n` +
    `MFG: ${webdfu.device.manufacturerName}\n` +
    `Serial: ${webdfu.device.serialNumber}\n`;

  // Display basic dfu-util style info
  if (webdfu) {
    dfuDisplay.textContent = formatDFUSummary(webdfu) + "\n" + memorySummary;
  } else {
    dfuDisplay.textContent = "Not found";
  }

  // Update buttons based on capabilities
  if (webdfu.currentInterfaceSettings?.alternate.interfaceProtocol == 0x01) {
    // Runtime
    uploadButton.disabled = false;
    downloadButton.disabled = true;
    firmwareFileField.disabled = true;
  } else {
    // DFU
    uploadButton.disabled = false;
    downloadButton.disabled = false;
    firmwareFileField.disabled = false;
  }

  if (webdfu.type === WebDFUType.SDFUse && webdfu.dfuseMemoryInfo) {
    const dfuseFieldsDiv = document.querySelector("#dfuseFields") as HTMLDivElement;
    dfuseFieldsDiv.hidden = false;
    dfuseStartAddressField.disabled = false;
    dfuseUploadSizeField.disabled = false;
    const segment = webdfu.getDfuseFirstWritableSegment();
    if (segment) {
      webdfu.dfuseStartAddress = segment.start;
      dfuseStartAddressField.value = "0x" + segment.start.toString(16);
      const maxReadSize = webdfu.getDfuseMaxReadSize(segment.start);
      dfuseUploadSizeField.value = maxReadSize.toString();
      dfuseUploadSizeField.max = maxReadSize.toString();
    }
  } else {
    const dfuseFieldsDiv = document.querySelector("#dfuseFields") as HTMLDivElement;
    dfuseFieldsDiv.hidden = true;
    dfuseStartAddressField.disabled = true;
    dfuseUploadSizeField.disabled = true;
  }
}

transferSizeField.addEventListener("change", () => {
  transferSize = parseInt(transferSizeField.value);
});

dfuseStartAddressField.addEventListener("change", function (event) {
  const field = event.target as HTMLInputElement;
  const address = parseInt(field.value, 16);
  if (isNaN(address)) {
    field.setCustomValidity("Invalid hexadecimal start address");
  } else if (webdfu && webdfu.type === WebDFUType.SDFUse && webdfu?.dfuseMemoryInfo) {
    if (webdfu.getDfuseSegment(address) !== null) {
      webdfu.dfuseStartAddress = address;
      field.setCustomValidity("");
      if (webdfu && webdfu.type === WebDFUType.SDFUse) {
        dfuseUploadSizeField.max = webdfu.getDfuseMaxReadSize(address).toString();
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

uploadButton.addEventListener("click", async function (event) {
  event.preventDefault();
  event.stopPropagation();
  if (!configForm.checkValidity()) {
    configForm.reportValidity();
    return false;
  }

  if (!webdfu || !webdfu.device.opened) {
    onDisconnect();
    webdfu = null;
  } else {
    setLogContext(uploadLog);
    clearLog(uploadLog);
    try {
      if (await webdfu.isError()) {
        await webdfu.clearStatus();
      }
    } catch (error) {
      logWarning("Failed to clear status");
    }

    let maxSize = Infinity;
    if (!dfuseUploadSizeField.disabled) {
      maxSize = parseInt(dfuseUploadSizeField.value);
    }

    try {
      const blob = await webdfu.read(transferSize, maxSize);

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

async function download(): Promise<void> {
  if (!configForm.checkValidity()) {
    configForm.reportValidity();
    return;
  }

  if (webdfu && firmwareFile != null) {
    setLogContext(downloadLog);
    clearLog(downloadLog);

    try {
      if (await webdfu.isError()) {
        await webdfu.clearStatus();
      }
    } catch (error) {
      logWarning("Failed to clear status");
    }

    try {
      await webdfu.write(transferSize, firmwareFile, manifestationTolerant);

      logInfo("Done!");
      setLogContext(null);

      if (!manifestationTolerant) {
        try {
          await webdfu.waitDisconnected(5000);

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

downloadButton.addEventListener("click", async function (event) {
  event.preventDefault();
  event.stopPropagation();

  download().catch(console.error);
});

if (typeof navigator.usb === "undefined") {
  statusDisplay.textContent = "WebUSB not available.";
  connectButton.disabled = true;
} else {
  navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
}
