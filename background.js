function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    // Practice Mark's content script exists only on YouTube. On any other tab,
    // sendMessage simply fails and is ignored.
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'PM_TOGGLE_PANEL' }).catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  sendToActiveTab({ type: 'PM_COMMAND', command });
});
