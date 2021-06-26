let logContext: HTMLDivElement | null = null;

export function setLogContext(div: HTMLDivElement | null): void {
  logContext = div;
}

export function clearLog(context = logContext): void {
  if (context) {
    context.innerHTML = "";
  }
}

export function logInfo(msg: string): void {
  if (logContext) {
    const info = document.createElement("p");
    info.className = "info";
    info.textContent = msg;
    logContext.appendChild(info);
  }
}

export function logWarning(msg: string): void {
  if (logContext) {
    const warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = msg;
    logContext.appendChild(warning);
  }
}

export function logError(msg: string): void {
  console.error(msg);
  if (logContext) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = msg;
    logContext.appendChild(error);
  }
}

export function logProgress(done: number, total?: number): void {
  if (logContext) {
    let progressBar: HTMLProgressElement | null = null;

    if (logContext?.lastElementChild?.tagName.toLowerCase() == "progress") {
      progressBar = logContext.lastElementChild as HTMLProgressElement;
    }

    if (!progressBar) {
      progressBar = document.createElement("progress");
      logContext.appendChild(progressBar);
    }

    progressBar.value = done;

    if (typeof total !== "undefined") {
      progressBar.max = total;
    }
  }
}
