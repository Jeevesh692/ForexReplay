// Chart screenshots for the journal.
//
// The chart library draws the candles, sessions, trade lines and drawings into one picture
// (`takeScreenshot`). A strip on top says what the picture is, because the legend in the
// corner of the chart is ordinary page text and is not in the library's picture.
// Pictures are sent to the local server, which keeps them in strategies/<journal>/screenshots/.

const STRIP = 26;

export const screenshotUrl = (journal, name) =>
  `/api/screenshots/${encodeURIComponent(journal)}/${encodeURIComponent(name)}`;

/** A PNG of the chart with a caption strip on top. Resolves to a Blob. */
export function capture(chartApi, caption) {
  const shot = chartApi.takeScreenshot();
  const canvas = document.createElement("canvas");
  canvas.width = shot.width;
  canvas.height = shot.height + STRIP;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1e222d";
  ctx.fillRect(0, 0, canvas.width, STRIP);
  ctx.fillStyle = "#d1d4dc";
  ctx.font = '13px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = "middle";
  ctx.fillText(caption, 10, STRIP / 2);
  ctx.drawImage(shot, 0, STRIP);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("the browser made no picture"))), "image/png"));
}

/** Send a PNG to the server. Throws with the server's reason if it is refused. */
export async function upload(journal, name, blob) {
  const response = await fetch(screenshotUrl(journal, name), { method: "PUT", headers: { "Content-Type": "image/png" }, body: blob });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
}

export async function remove(journal, name) {
  await fetch(screenshotUrl(journal, name), { method: "DELETE" });
}
