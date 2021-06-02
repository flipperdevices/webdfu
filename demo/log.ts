let logContext = null;

export function setLogContext(div) {
  logContext = div;
}

export function clearLog(context) {
  if (typeof context === "undefined") {
    context = logContext;
  }
  if (context) {
    context.innerHTML = "";
  }
}

export function logDebug(msg) {
  console.log(msg);
}

export function logInfo(msg) {
  if (logContext) {
    let info = document.createElement("p");
    info.className = "info";
    info.textContent = msg;
    logContext.appendChild(info);
  }
}

export function logWarning(msg) {
  if (logContext) {
    let warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = msg;
    logContext.appendChild(warning);
  }
}

export function logError(msg) {
  if (logContext) {
    let error = document.createElement("p");
    error.className = "error";
    error.textContent = msg;
    logContext.appendChild(error);
  }
}

export function logProgress(done, total) {
  if (logContext) {
    let progressBar;
    if (logContext.lastChild.tagName.toLowerCase() == "progress") {
      progressBar = logContext.lastChild;
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
