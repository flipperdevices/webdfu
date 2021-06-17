# WebDFU

[![NPM package](https://img.shields.io/npm/v/dfu)](https://www.npmjs.com/package/dfu)
[![CI in main branch](https://github.com/Flipper-Zero/webdfu/actions/workflows/main.yml/badge.svg)](https://github.com/Flipper-Zero/webdfu/actions/workflows/main.yml)

WebDFU — driver for working with DFU and DfuseDriver in a browser over [Web USB](https://wicg.github.io/webusb/) or [Web Bluetooth](https://webbluetoothcg.github.io/web-bluetooth/).

- Reading and writing the current device firmware by [DFU 1.1](https://www.usb.org/sites/default/files/DFU_1.1.pdf)
- [ST DfuSe](http://dfu-util.sourceforge.net/dfuse.html) download and upload firmware
- Switching from the runtime configuration to the DFU bootloader (DFU detach)

## Install

```shell
npm i dfu
```

## Usage

Full example in: [webdfu/demo](https://github.com/Flipper-Zero/webdfu/tree/main/demo)

Basic example:

```javascript
async function connect() {
  // Load the device by WebUSB
  const selectedDevice = await navigator.usb.requestDevice({ filters: [] });

  // Create and init the WebDFU instance
  const webdfu = new WebDFU(selectedDevice, { forceInterfacesName: true });
  await webdfu.init();

  if (webdfu.interfaces.length == 0) {
    throw new Error("The selected device does not have any USB DFU interfaces.");
  }

  await webdfu.connect(interfaceIndex);

  console.log({
    Version: webdfu.properties.DFUVersion.toString(16),
    CanUpload: webdfu.properties.CanUpload,
    CanDownload: webdfu.properties.CanDnload,
    TransferSize: webdfu.properties.TransferSize,
    TransferSize: webdfu.properties.TransferSize,
    DetachTimeOut: webdfu.properties.DetachTimeOut,
  });

  // Read firmware from device
  try {
    const firmwareFile = await webdfu.read();

    console.log("Readed: ", firmwareFile);
  } catch (error) {
    console.error(error);
  }

  // Write firmware in device
  try {
    // Your firmware in binary mode
    const firmwareFile = new ArrayBuffer("");
    await webdfu.write(1024, firmwareFile);

    console.log("Writed!");
  } catch (error) {
    console.error(error);
  }
}

connect().catch(console.error);
```
