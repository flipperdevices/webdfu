import { dfu, DFU, DFUse, WebDFU, WebDFUType } from "../index";

import { clearLog, logDebug, logError, logInfo, logProgress, logWarning, setLogContext } from "./log";

// Utils
function hex4(n) {
  let s = n.toString(16);

  while (s.length < 4) {
    s = "0" + s;
  }

  return s;
}

function hexAddr8(n) {
  let s = n.toString(16);
  while (s.length < 8) {
    s = "0" + s;
  }
  return "0x" + s;
}

function niceSize(n) {
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

function formatDFUSummary(device: DFU) {
  const vid = hex4(device.device_.vendorId);
  const pid = hex4(device.device_.productId);
  const name = device.device_.productName;

  let mode = "Unknown";
  if (device.settings.alternate.interfaceProtocol == 0x01) {
    mode = "Runtime";
  } else if (device.settings.alternate.interfaceProtocol == 0x02) {
    mode = "DFU";
  }

  const cfg = device.settings.configuration.configurationValue;
  const intf = device.settings["interface"].interfaceNumber;
  const alt = device.settings.alternate.alternateSetting;
  const serial = device.device_.serialNumber;

  return `${mode}: [${vid}:${pid}] cfg=${cfg}, intf=${intf}, alt=${alt}, name="${name}" serial="${serial}"`;
}

// Current page
let webdfu: WebDFU | null = null;

let connectButton = document.querySelector("#connect") as HTMLButtonElement;
let downloadButton = document.querySelector("#download") as HTMLButtonElement;
let uploadButton = document.querySelector("#upload") as HTMLButtonElement;
let statusDisplay = document.querySelector("#status") as HTMLDivElement;
let infoDisplay = document.querySelector("#usbInfo") as HTMLDivElement;
let dfuDisplay = document.querySelector("#dfuInfo") as HTMLDivElement;

let configForm = document.querySelector("#configForm") as HTMLFormElement;

let transferSizeField = document.querySelector("#transferSize") as HTMLInputElement;
let transferSize = parseInt(transferSizeField.value);

let dfuseStartAddressField = document.querySelector("#dfuseStartAddress") as HTMLInputElement;
let dfuseUploadSizeField = document.querySelector("#dfuseUploadSize") as HTMLInputElement;

let firmwareFileField = document.querySelector("#firmwareFile") as HTMLInputElement;
let firmwareFile = null;

let downloadLog = document.querySelector("#downloadLog") as HTMLDivElement;
let uploadLog = document.querySelector("#uploadLog") as HTMLDivElement;

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

function onUnexpectedDisconnect(event) {
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

  if (!webdfu.dfu) {
    throw new Error();
  }

  let memorySummary = "";
  if (webdfu.properties) {
    const desc = webdfu.properties;

    let info = [
      `WillDetach=${webdfu.properties.WillDetach}`,
      `ManifestationTolerant=${webdfu.properties.ManifestationTolerant}`,
      `CanUpload=${webdfu.properties.CanUpload}`,
      `CanDownload=${webdfu.properties.CanDnload}`,
      `TransferSize=${webdfu.properties.TransferSize}`,
      `DetachTimeOut=${webdfu.properties.DetachTimeOut}`,
      `Version=${hex4(webdfu.properties.DFUVersion)}`,
    ];

    dfuDisplay.textContent += "\n" + info.join(", ");
    transferSizeField.value = webdfu.properties.TransferSize.toString();
    transferSize = webdfu.properties.TransferSize;

    if (webdfu.properties.CanDnload) {
      manifestationTolerant = webdfu.properties.ManifestationTolerant;
    }

    if (webdfu.dfu.settings.alternate.interfaceProtocol == 0x02) {
      if (!desc.CanUpload) {
        uploadButton.disabled = false;
        dfuseUploadSizeField.disabled = true;
      }

      if (!desc.CanDnload) {
        downloadButton.disabled = true;
      }
    }

    if (webdfu.type === WebDFUType.SDFUse && webdfu.dfu instanceof DFUse) {
      if (webdfu.dfu.memoryInfo) {
        let totalSize = 0;
        for (let segment of webdfu.dfu.memoryInfo.segments) {
          totalSize += segment.end - segment.start;
        }
        memorySummary = `Selected memory region: ${webdfu.dfu.memoryInfo.name} (${niceSize(totalSize)})`;
        for (let segment of webdfu.dfu.memoryInfo.segments) {
          let properties = [];
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

  // Bind logging methods
  webdfu.dfu.logDebug = logDebug;
  webdfu.dfu.logInfo = logInfo;
  webdfu.dfu.logWarning = logWarning;
  webdfu.dfu.logError = logError;
  webdfu.dfu.logProgress = logProgress;

  // Clear logs
  clearLog(uploadLog);
  clearLog(downloadLog);

  // Display basic USB information
  statusDisplay.textContent = "";
  connectButton.textContent = "Disconnect";
  infoDisplay.textContent =
    `Name: ${webdfu.dfu.device_.productName}\n` +
    `MFG: ${webdfu.dfu.device_.manufacturerName}\n` +
    `Serial: ${webdfu.dfu.device_.serialNumber}\n`;

  // Display basic dfu-util style info
  if (webdfu.dfu) {
    dfuDisplay.textContent = formatDFUSummary(webdfu.dfu) + "\n" + memorySummary;
  } else {
    dfuDisplay.textContent = "Not found";
  }

  // Update buttons based on capabilities
  if (webdfu.dfu?.settings.alternate.interfaceProtocol == 0x01) {
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

  if (webdfu.dfu instanceof DFUse && webdfu.dfu.memoryInfo) {
    let dfuseFieldsDiv = document.querySelector("#dfuseFields") as HTMLDivElement;
    dfuseFieldsDiv.hidden = false;
    dfuseStartAddressField.disabled = false;
    dfuseUploadSizeField.disabled = false;
    let segment = webdfu.dfu.getFirstWritableSegment();
    if (segment) {
      webdfu.dfu.startAddress = segment.start;
      dfuseStartAddressField.value = "0x" + segment.start.toString(16);
      const maxReadSize = webdfu.dfu.getMaxReadSize(segment.start);
      dfuseUploadSizeField.value = maxReadSize.toString();
      dfuseUploadSizeField.max = maxReadSize.toString();
    }
  } else {
    let dfuseFieldsDiv = document.querySelector("#dfuseFields") as HTMLDivElement;
    dfuseFieldsDiv.hidden = true;
    dfuseStartAddressField.disabled = true;
    dfuseUploadSizeField.disabled = true;
  }

  return webdfu.dfu;
}

transferSizeField.addEventListener("change", () => {
  transferSize = parseInt(transferSizeField.value);
});

dfuseStartAddressField.addEventListener("change", function (event) {
  const field = event.target as HTMLInputElement;
  let address = parseInt(field.value, 16);
  if (isNaN(address)) {
    field.setCustomValidity("Invalid hexadecimal start address");
  } else if (webdfu?.dfu && webdfu.dfu instanceof DFUse && webdfu?.dfu?.memoryInfo) {
    if (webdfu?.dfu.getSegment(address) !== null) {
      webdfu.dfu.startAddress = address;
      field.setCustomValidity("");
      if (webdfu?.dfu && webdfu?.dfu instanceof DFUse) {
        dfuseUploadSizeField.max = webdfu.dfu.getMaxReadSize(address).toString();
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
      webdfu = new WebDFU(selectedDevice, { forceInterfacesName: true });
      webdfu.events.on("disconnect", onDisconnect);

      await webdfu.init();

      if (webdfu.interfaces.length == 0) {
        statusDisplay.textContent = "The selected device does not have any USB DFU interfaces.";
        return;
      }

      await connect(0);
    })
    .catch((error) => {
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

  if (!webdfu?.dfu || !webdfu?.dfu.device_.opened) {
    onDisconnect();
    webdfu = null;
  } else {
    setLogContext(uploadLog);
    clearLog(uploadLog);
    try {
      let status = await webdfu?.dfu.getStatus();
      if (status.state == dfu.dfuERROR) {
        await webdfu?.dfu.clearStatus();
      }
    } catch (error) {
      webdfu?.dfu.logWarning("Failed to clear status");
    }

    let maxSize = Infinity;
    if (!dfuseUploadSizeField.disabled) {
      maxSize = parseInt(dfuseUploadSizeField.value);
    }

    try {
      const blob = await webdfu?.dfu.do_upload(transferSize, maxSize);

      // Global function in FileSaver.js
      // @ts-ignore
      window.saveAs(blob, "firmware.bin");
    } catch (error) {
      logError(error);
    }

    setLogContext(null);
  }

  return false;
});

firmwareFileField.addEventListener("change", function () {
  firmwareFile = null;
  if (firmwareFileField.files.length > 0) {
    let file = firmwareFileField.files?.[0] as Blob;
    let reader = new FileReader();
    reader.onload = function () {
      firmwareFile = reader.result;
    };
    reader.readAsArrayBuffer(file);
  }
});

downloadButton.addEventListener("click", async function (event) {
  event.preventDefault();
  event.stopPropagation();

  if (!configForm.checkValidity()) {
    configForm.reportValidity();
    return false;
  }

  if (webdfu?.dfu && firmwareFile != null) {
    setLogContext(downloadLog);
    clearLog(downloadLog);

    try {
      let status = await webdfu?.dfu.getStatus();

      if (status.state == dfu.dfuERROR) {
        await webdfu?.dfu.clearStatus();
      }
    } catch (error) {
      webdfu?.dfu.logWarning("Failed to clear status");
    }

    try {
      await webdfu?.dfu.do_download(transferSize, firmwareFile, manifestationTolerant);

      logInfo("Done!");
      setLogContext(null);

      if (!manifestationTolerant) {
        try {
          await webdfu?.dfu.waitDisconnected(5000);

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
});

if (typeof navigator.usb === "undefined") {
  statusDisplay.textContent = "WebUSB not available.";
  connectButton.disabled = true;
} else {
  navigator.usb.addEventListener("disconnect", onUnexpectedDisconnect);
}
