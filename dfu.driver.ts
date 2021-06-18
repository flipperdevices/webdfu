import { dfuCommands, WebDFUDriver } from "./base.driver";
import { WebDFUError } from "./core";

export class DriverDFU extends WebDFUDriver {
  // Public interface
  async do_read(xfer_size: number, max_size = Infinity, first_block = 0): Promise<Blob> {
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

  async do_write(xfer_size: number, data: ArrayBuffer, manifestationTolerant = true): Promise<void> {
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
        dfu_status = await this.poll_until_idle(dfuCommands.dfuDNLOAD_IDLE);
      } catch (error) {
        throw new WebDFUError("Error during DFU download: " + error);
      }

      if (dfu_status.status != dfuCommands.STATUS_OK) {
        throw new WebDFUError(`DFU DOWNLOAD failed state=${dfu_status.state}, status=${dfu_status.status}`);
      }

      this.logDebug("Wrote " + bytes_written + " bytes");
      bytes_sent += bytes_written;

      this.logProgress(bytes_sent, expected_size);
    }

    this.logDebug("Sending empty block");
    try {
      await this.download(new ArrayBuffer(0), transaction++);
    } catch (error) {
      throw new WebDFUError("Error during final DFU download: " + error);
    }

    this.logInfo("Wrote " + bytes_sent + " bytes");
    this.logInfo("Manifesting new firmware");

    if (manifestationTolerant) {
      // Transition to MANIFEST_SYNC state
      let dfu_status;
      try {
        // Wait until it returns to idle.
        // If it's not really manifestation tolerant, it might transition to MANIFEST_WAIT_RESET
        dfu_status = await this.poll_until(
          (state) => state == dfuCommands.dfuIDLE || state == dfuCommands.dfuMANIFEST_WAIT_RESET
        );
        if (dfu_status.state == dfuCommands.dfuMANIFEST_WAIT_RESET) {
          this.logDebug("Device transitioned to MANIFEST_WAIT_RESET even though it is manifestation tolerant");
        }
        if (dfu_status.status != dfuCommands.STATUS_OK) {
          throw new WebDFUError(`DFU MANIFEST failed state=${dfu_status.state}, status=${dfu_status.status}`);
        }
      } catch (error) {
        if (
          error.endsWith("ControlTransferIn failed: NotFoundError: Device unavailable.") ||
          error.endsWith("ControlTransferIn failed: NotFoundError: The device was disconnected.")
        ) {
          this.logWarning("Unable to poll final manifestation status");
        } else {
          throw new WebDFUError("Error during DFU manifest: " + error);
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
      await this.device.reset();
    } catch (error) {
      if (
        error == "NetworkError: Unable to reset the device." ||
        error == "NotFoundError: Device unavailable." ||
        error == "NotFoundError: The device was disconnected."
      ) {
        this.logDebug("Ignored reset error");
      } else {
        throw new WebDFUError("Error during reset for manifestation: " + error);
      }
    }
  }
}
