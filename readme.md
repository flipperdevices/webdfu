# WebDFU

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

  // Your firmware in binary mode
  const firmwareFile = new ArrayBuffer('' /* Your firmware */);
  await webdfu?.dfu.do_download(1024, firmwareFile, true);

  console.log("Done!");
}

connect().catch(console.error);
```
