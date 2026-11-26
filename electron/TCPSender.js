const net = require("net");
const { ipcMain } = require("electron");

function sendTcpMessage(msg, expectResponse = false) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let responseBuffer = "";
    let finished = false;

    const finish = (fn, value) => {
      if (finished) return;
      finished = true;
      try {
        client.destroy();
      } catch {}
      fn(value);
    };

    client.setTimeout(expectResponse ? 5000 : 3000);

    client
      .connect(42070, "127.0.0.1", function () {
        client.write(JSON.stringify(msg) + "\n");

        if (!expectResponse) {
          client.end();
        }
      })
      .on("data", (data) => {
        responseBuffer += data.toString();
      })
      .on("end", () => {
        if (!expectResponse) {
          finish(resolve, null);
          return;
        }

        const trimmed = responseBuffer.trim();
        if (!trimmed) {
          finish(resolve, null);
          return;
        }

        try {
          finish(resolve, JSON.parse(trimmed));
        } catch {
          finish(resolve, { raw: trimmed });
        }
      })
      .on("timeout", () => {
        finish(reject, new Error("TCP request timed out"));
      })
      .on("error", (e) => {
        finish(reject, e);
      });
  });
}

// Messages go to DCS one at a time, in the order they were sent. Firing several
// connections at once (e.g. a status line and the waypoints) could get one
// refused while TheWay.lua was busy with the other, silently dropping it.
const RETRY_CODES = new Set(["ECONNREFUSED", "ECONNRESET"]);
const RETRIES = 3;
const RETRY_DELAY_MS = 100;

let queue = Promise.resolve();

const sendWithRetry = async (msg, expectResponse) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendTcpMessage(msg, expectResponse);
    } catch (e) {
      if (attempt >= RETRIES || !RETRY_CODES.has(e.code)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
};

// Queue a message for DCS; resolves with the response (or null).
const sendToDcs = (msg, expectResponse = false) => {
  const result = queue.then(() => sendWithRetry(msg, expectResponse));
  queue = result.catch(() => {}); // a failed message doesn't block the next
  return result;
};

class TCPSender {
  constructor() {
    ipcMain.on("messageToDcs", (_event, msg) => {
      sendToDcs(msg, false).catch((e) => {
        console.log(`[TheWay] message to DCS (${msg?.type || msg?.cmd}) failed: ${e.code || e.message}`);
      });
    });

    ipcMain.handle("messageToDcsRequest", async (_event, msg) => {
      return await sendToDcs(msg, true);
    });
  }
}

module.exports = TCPSender;
module.exports.sendToDcs = sendToDcs;
