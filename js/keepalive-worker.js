let interval = null;

self.onmessage = (e) => {
  if (e.data.type === 'start') {
    const ms = e.data.interval || 5000;
    clearInterval(interval);
    interval = setInterval(() => {
      self.postMessage('ping');
    }, ms);
  } else if (e.data.type === 'stop') {
    clearInterval(interval);
    interval = null;
  }
};
