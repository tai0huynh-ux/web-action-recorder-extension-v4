import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedRunUrl, matchesSwitchTabPattern, matchesText, normalizeProfile, validateProfile, validateSafeShortcut, wildcardToRegExp } from '../src/shared.js';

test('wildcard matching is anchored and case insensitive', () => {
  assert.equal(wildcardToRegExp('*Example.COM*').test('www.example.com'), true);
  assert.equal(matchesText('Hello World', 'contains', '*world*'), true);
});

test('normalize profile supplies safe defaults', () => {
  const profile = normalizeProfile({ name: 'Test', steps: [{ type: 'log' }] });
  assert.ok(profile.id);
  assert.ok(profile.steps[0].id);
  assert.equal(profile.allowHighRisk, false);
});

test('validation rejects duplicate ids and unsupported types', () => {
  assert.throws(() => validateProfile({ name: 'x', steps: [{ id: 'a', type: 'log' }, { id: 'a', type: 'log' }] }), /Tr/);
  assert.throws(() => validateProfile({ name: 'x', steps: [{ type: 'javascript' }] }), /kh/);
});

test('validation allows only safe copy shortcuts', () => {
  assert.equal(validateSafeShortcut(['CTRL', 'A']), 'CTRL+A');
  assert.equal(validateSafeShortcut('CTRL+C'), 'CTRL+C');
  assert.equal(validateProfile({ name: 'copy', steps: [{ id: 'a', type: 'shortcut', keys: ['CTRL', 'C'] }] }), true);
  assert.throws(() => validateProfile({ name: 'bad', steps: [{ id: 'a', type: 'shortcut', keys: ['CTRL', 'V'] }] }), /Shortcut/);
});

test('switch tab wildcard matches URL path', () => {
  assert.equal(matchesSwitchTabPattern({ url: 'https://shop.example.com/orders/42', title: 'Orders' }, '*example.com/orders*'), true);
});

test('switch tab wildcard matches subdomain URL', () => {
  assert.equal(matchesSwitchTabPattern({ url: 'https://app.example.com/dashboard', title: 'Dashboard' }, 'https://*.example.com/*'), true);
});

test('switch tab matching is case-insensitive', () => {
  assert.equal(matchesSwitchTabPattern({ url: 'https://example.com/Orders', title: 'ACME Portal' }, '*orders*'), true);
});

test('switch tab pattern without wildcard uses substring matching', () => {
  assert.equal(matchesSwitchTabPattern({ url: 'https://example.com/home', title: 'Sales Dashboard' }, 'dashboard'), true);
});

test('switch tab returns false for nonmatching URL and title', () => {
  assert.equal(matchesSwitchTabPattern({ url: 'https://example.com/home', title: 'Home' }, '*dashboard*'), false);
});

test('switch tab rejects empty patterns', () => {
  assert.throws(() => matchesSwitchTabPattern({ url: 'https://example.com', title: 'Example' }, '   '), /empty/);
});

test('restricted URLs are rejected as run targets', () => {
  assert.equal(isSupportedRunUrl('chrome://extensions'), false);
  assert.equal(isSupportedRunUrl('edge://extensions'), false);
  assert.equal(isSupportedRunUrl('about:blank'), false);
  assert.equal(isSupportedRunUrl('chrome-extension://abc/ui/sidepanel.html'), false);
  assert.equal(matchesSwitchTabPattern({ url: 'chrome://extensions', title: 'Extensions' }, '*extensions*'), false);
});
