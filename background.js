// Downloads + OS notifications
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "download") {
    try { chrome.downloads.download({ url: msg.url }); } catch {}
    notify("Downloading image", msg.url || "");
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg?.type === "downloadAll") {
    const urls = msg.urls || [];
    urls.forEach(url => { try { chrome.downloads.download({ url }); } catch {} });
    notify("Downloading images", `${urls.length} file(s)`);
    sendResponse?.({ ok: true, count: urls.length });
    return true;
  }
  if (msg?.type === "notify") {
    notify(msg.title || "Image Viewer", msg.message || "");
    sendResponse?.({ ok: true });
    return true;
  }
});

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/128.png",
      title,
      message
    });
  } catch {}
}