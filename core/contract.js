'use strict';

/*
 * Unified contract for the OpenChamber egress matrix.
 *
 * This file is a byte-for-byte equivalent of
 * `openchamber-egress-matrix/core/contract.js` and must stay aligned with the
 * copy used by `openchamber-cloudflare`. Every module, API payload and shared
 * state file uses these names and enums. No synonyms, no ad-hoc port math
 * outside this file.
 */

const SLOT_MIN_INDEX = 1;
const SLOT_MAX_INDEX = 250;
const SLOT_COUNT = SLOT_MAX_INDEX - SLOT_MIN_INDEX + 1;
const EGRESS_PORT_BASE = 24000;
const EGRESS_PORT_MIN = EGRESS_PORT_BASE + SLOT_MIN_INDEX;
const EGRESS_PORT_MAX = EGRESS_PORT_BASE + SLOT_MAX_INDEX;

const ROUTING_PLANES = Object.freeze(['STRICT_CONTROL', 'ELASTIC_DATA']);
const HEALTH_STATES = Object.freeze([
  'ACTIVE',
  'COOLDOWN',
  'QUARANTINED',
  'WARP_OVERFLOW',
  'ROTATING',
]);

const DEFAULT_CONTROL_DOMAINS = Object.freeze([
  'api.cloudflare.com',
  'dash.cloudflare.com',
  'api.instabox.sh',
  'api.instabox.tech',
  'auth.instabox.sh',
  'console.instabox.sh',
]);

const BLOCKED_HEALTH_STATES = Object.freeze(['QUARANTINED', 'WARP_OVERFLOW', 'ROTATING']);

function isInteger(value) {
  return Number.isInteger(value);
}

function slotIdForIndex(index) {
  if (!isInteger(index) || index < SLOT_MIN_INDEX || index > SLOT_MAX_INDEX) {
    throw Object.assign(new Error(`矩阵槽位索引必须是 ${SLOT_MIN_INDEX}-${SLOT_MAX_INDEX}`), {
      code: 'invalid_slot_index',
    });
  }
  return `slot-${String(index).padStart(3, '0')}`;
}

function indexForSlotId(matrixSlotId) {
  const match = /^slot-(\d{3})$/.exec(String(matrixSlotId || ''));
  if (!match) return 0;
  const index = Number(match[1]);
  return index >= SLOT_MIN_INDEX && index <= SLOT_MAX_INDEX ? index : 0;
}

function egressPortForIndex(index) {
  return EGRESS_PORT_BASE + index;
}

function egressPortForSlotId(matrixSlotId) {
  const index = indexForSlotId(matrixSlotId);
  return index ? egressPortForIndex(index) : 0;
}

function matrixSlotIdForPort(port) {
  const value = Number(port);
  if (!isInteger(value) || value < EGRESS_PORT_MIN || value > EGRESS_PORT_MAX) return '';
  return slotIdForIndex(value - EGRESS_PORT_BASE);
}

function isMatrixPort(port) {
  return Boolean(matrixSlotIdForPort(port));
}

function normalizeRoutingPlane(value, fallback = 'ELASTIC_DATA') {
  const plane = String(value || '').toUpperCase();
  return ROUTING_PLANES.includes(plane) ? plane : fallback;
}

function normalizeHealthState(value, fallback = 'ACTIVE') {
  const state = String(value || '').toUpperCase();
  return HEALTH_STATES.includes(state) ? state : fallback;
}

function stripHextet(value) {
  const text = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{1,4}$/.test(text)) return '';
  return text === '0000' ? '0' : text.replace(/^0+(?=.)/, '');
}

/*
 * Fully expand an IPv6 literal into its eight 16-bit hextets. Compressed
 * (`::`), bracketed (`[..]`) and prefix-length forms are accepted; anything
 * malformed returns null. This is the only place IPv6 parsing happens.
 */
function expandIpv6(value) {
  let text = String(value || '').trim();
  if (!text) return null;
  const slash = text.indexOf('/');
  if (slash >= 0) text = text.slice(0, slash);
  text = text.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let parts;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    parts = [...head, ...new Array(fill).fill('0'), ...tail];
  } else {
    if (head.length !== 8) return null;
    parts = head;
  }
  if (parts.length !== 8) return null;
  const expanded = parts.map(stripHextet);
  if (expanded.some((part) => !part)) return null;
  return expanded;
}

function normalizePrefix64(value) {
  const parts = expandIpv6(value);
  if (!parts) return '';
  return `${parts.slice(0, 4).join(':')}::/64`;
}

function hostMatchesDomain(host, domain) {
  const target = String(host || '').toLowerCase().replace(/\.$/, '');
  const root = String(domain || '').toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!target || !root) return false;
  return target === root || target.endsWith(`.${root}`);
}

function isControlPlaneHost(host, domains = DEFAULT_CONTROL_DOMAINS) {
  const list = Array.isArray(domains) && domains.length ? domains : DEFAULT_CONTROL_DOMAINS;
  return list.some((domain) => hostMatchesDomain(host, domain));
}

function emptyFingerprint(leaseId = '') {
  return {
    exitIp: '',
    ipv6Prefix64: '',
    asn: '',
    leaseId: String(leaseId || ''),
    updatedAt: Date.now(),
  };
}

function normalizeFingerprint(value, fallbackLeaseId = '') {
  const source = value && typeof value === 'object' ? value : {};
  return {
    exitIp: String(source.exitIp || ''),
    ipv6Prefix64: normalizePrefix64(source.ipv6Prefix64 || ''),
    asn: String(source.asn || ''),
    leaseId: String(source.leaseId || fallbackLeaseId || ''),
    updatedAt: Number(source.updatedAt) || Date.now(),
  };
}

function validateLeaseRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return ['lease record must be an object'];
  if (!indexForSlotId(record.matrixSlotId)) errors.push('matrixSlotId must be slot-001..slot-250');
  if (!isInteger(record.egressPort)
    || record.egressPort !== egressPortForSlotId(record.matrixSlotId)) {
    errors.push('egressPort must equal 24000 + slot index');
  }
  if (!ROUTING_PLANES.includes(record.routingPlane)) errors.push('routingPlane invalid');
  if (!HEALTH_STATES.includes(record.healthState)) errors.push('healthState invalid');
  if (!record.egressFingerprint || typeof record.egressFingerprint !== 'object') {
    errors.push('egressFingerprint missing');
  } else if (normalizePrefix64(record.egressFingerprint.ipv6Prefix64)
    !== record.egressFingerprint.ipv6Prefix64) {
    errors.push('egressFingerprint.ipv6Prefix64 must be a normalized /64 prefix');
  }
  return errors;
}

function isBlockedHealthState(value) {
  return BLOCKED_HEALTH_STATES.includes(normalizeHealthState(value));
}

function slotRecord({ matrixSlotId, routingPlane, healthState, egressFingerprint, leaseId, stats } = {}) {
  const index = indexForSlotId(matrixSlotId);
  if (!index) {
    throw Object.assign(new Error('matrixSlotId 必须是 slot-001..slot-250'), {
      code: 'invalid_slot',
    });
  }
  const fingerprint = normalizeFingerprint(egressFingerprint, leaseId);
  return {
    matrixSlotId,
    egressPort: egressPortForIndex(index),
    routingPlane: normalizeRoutingPlane(routingPlane, 'ELASTIC_DATA'),
    healthState: normalizeHealthState(healthState),
    egressFingerprint: fingerprint,
    leaseId: String(leaseId || fingerprint.leaseId || ''),
    intentId: '',
    key: '',
    provider: '',
    country: '',
    lastError: null,
    stats: stats && typeof stats === 'object' ? stats : {},
  };
}

module.exports = {
  SLOT_MIN_INDEX,
  SLOT_MAX_INDEX,
  SLOT_COUNT,
  EGRESS_PORT_BASE,
  EGRESS_PORT_MIN,
  EGRESS_PORT_MAX,
  ROUTING_PLANES,
  HEALTH_STATES,
  BLOCKED_HEALTH_STATES,
  DEFAULT_CONTROL_DOMAINS,
  slotIdForIndex,
  indexForSlotId,
  egressPortForIndex,
  egressPortForSlotId,
  matrixSlotIdForPort,
  isMatrixPort,
  normalizeRoutingPlane,
  normalizeHealthState,
  isBlockedHealthState,
  normalizePrefix64,
  expandIpv6,
  hostMatchesDomain,
  isControlPlaneHost,
  emptyFingerprint,
  normalizeFingerprint,
  validateLeaseRecord,
  slotRecord,
};
