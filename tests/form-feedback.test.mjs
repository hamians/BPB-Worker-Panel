import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../_worker.js', import.meta.url), 'utf8');
const { renderHomePage, renderLoginPage } = vm.runInNewContext(
  source.replace(/^import .*cloudflare:sockets.*;$/m, '').replace('export default', 'const worker =') +
  '\n;({ renderHomePage, renderLoginPage });'
);
const defaults = {
  remoteDNS: 'https://example.com/dns-query', localDNS: '8.8.8.8',
  lengthMin: 100, lengthMax: 200, intervalMin: 5, intervalMax: 10,
  blockAds: false, bypassIran: false, cleanIPs: '', outProxy: ''
};
const panelHTML = await renderHomePage({ bpb: { get: async () => defaults } }, 'localhost', []);
const loginHTML = await renderLoginPage();
const script = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];

function page(html, fetch) {
  const elements = Object.fromEntries(Object.entries({
    localDNS: '8.8.8.8', fragmentLengthMin: '100', fragmentLengthMax: '200', fragmentIntervalMin: '5',
    fragmentIntervalMax: '10', cleanIPs: '', outProxy: '', password: 'example',
    applyButton: 'APPLY SETTINGS 💥', settingsError: '', passwordError: ''
  }).map(([id, value]) => [id, {
    id, value, style: {}, addEventListener() {}, textContent: '', disabled: false, dataset: {},
    classList: { add() {}, toggle() {} }
  }]));
  for (const id of ['myModal', 'openModalBtn', 'passwordChangeForm', 'logout', 'close']) {
    elements[id] = { style: {}, addEventListener() {} };
  }
  const button = { disabled: false, textContent: 'Login' };
  const listeners = {};
  const fields = Object.values(elements).filter(element => element.id && !['applyButton', 'settingsError', 'passwordError', 'password'].includes(element.id));
  const form = {
    elements: fields,
    querySelector: () => button,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    dispatchEvent(event) { listeners[event.type]?.(event); }
  };
  const location = { href: '', reload() { this.reloaded = true; } };
  let ready;
  const document = {
    getElementById: id => ['loginForm', 'configForm'].includes(id) ? form : elements[id],
    querySelector: () => elements.close,
    addEventListener(name, callback) { if (name === 'DOMContentLoaded') ready = callback; }, body: { style: { cursor: '' } }
  };
  const context = vm.createContext({
    document, window: { location }, fetch, Event,
    FormData: class {
      constructor(form) { this.data = new Map(form.elements.map(field => [field.id, field.value])); }
      has(key) { return this.data.has(key); }
      get(key) { return this.data.get(key); }
      entries() { return this.data.entries(); }
    },
    alert() {}, console: { error() {} }
  });
  vm.runInContext(script(html), context);
  if (ready) {
    elements.applyButton.disabled = true;
    ready();
    elements.localDNS.value = '1.1.1.1';
    form.dispatchEvent(new Event('input'));
  }
  const event = { preventDefault() {}, stopPropagation() {}, currentTarget: form };
  return {
    elements, button, location, document, form,
    submit: () => listeners.submit(event)
  };
}

for (const [name, html, errorId] of [
  ['login', loginHTML, 'passwordError'], ['settings', panelHTML, 'settingsError']
]) {
  test(`${name}: network failure gives feedback and permits retry`, async () => {
    let calls = 0;
    const app = page(html, async () => { calls++; throw new TypeError('offline'); });
    await app.submit();
    assert.match(app.elements[errorId].textContent, /Check your connection/);
    assert.equal(app.location.href, '');
    assert.equal(html === loginHTML ? app.button.disabled : app.elements.applyButton.disabled, false);
    assert.equal(app.elements.applyButton.value, 'APPLY SETTINGS 💥');
    assert.equal(app.document.body.style.cursor, '');
    await app.submit();
    assert.equal(calls, 2);
  });

  test(`${name}: pending request cannot be submitted twice`, async () => {
    let calls = 0;
    let resolve;
    const app = page(html, () => {
      calls++;
      return new Promise(done => { resolve = done; });
    });
    const first = app.submit();
    assert.equal(html === loginHTML ? app.button.disabled : app.elements.applyButton.disabled, true);
    await app.submit();
    assert.equal(calls, 1);
    resolve(new Response('Failed', { status: 500 }));
    await first;
    assert.equal(html === loginHTML ? app.button.disabled : app.elements.applyButton.disabled, false);
  });

  test(`${name}: server failure stays on the form with actionable feedback`, async () => {
    const app = page(html, async () => new Response('Server error', { status: 500 }));
    const input = html === loginHTML ? app.elements.password : app.elements.cleanIPs;
    input.value = '1.1.1.1';
    await app.submit();
    assert.match(app.elements[errorId].textContent, /try again/);
    assert.doesNotMatch(app.elements[errorId].textContent, /Wrong Password|Session expired/);
    assert.equal(app.location.href, '');
    assert.equal(input.value, '1.1.1.1');
  });

  test(`${name}: successful submission keeps the existing destination`, async () => {
    const app = page(html, async () => new Response('OK'));
    await app.submit();
    if (html === loginHTML) assert.equal(app.location.href, '/panel');
    else assert.equal(app.location.reloaded, true);
  });
}

test('login: incorrect password is distinguished from a server failure', async () => {
  const app = page(loginHTML, async () => new Response('Wrong Password', { status: 405 }));
  await app.submit();
  assert.match(app.elements.passwordError.textContent, /Wrong Password/);
});

test('settings: expired session redirects to login', async () => {
  const app = page(panelHTML, async () => new Response('Unauthorized', { status: 401 }));
  await app.submit();
  assert.equal(app.location.href, '/login');
});

test('settings: validation still prevents an invalid request', async () => {
  const app = page(panelHTML, () => { assert.fail('must not submit'); });
  app.elements.fragmentLengthMin.value = '300';
  await app.submit();
});


test('settings: reverting edits during a request keeps the button disabled afterwards', async () => {
  let resolve;
  const app = page(panelHTML, () => new Promise(done => { resolve = done; }));
  const pending = app.submit();
  app.elements.localDNS.value = '8.8.8.8';
  app.form.dispatchEvent(new Event('input'));
  assert.equal(app.elements.applyButton.disabled, true);
  resolve(new Response('Server error', { status: 500 }));
  await pending;
  assert.equal(app.elements.applyButton.disabled, true);
});
