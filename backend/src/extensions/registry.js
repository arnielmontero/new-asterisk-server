'use strict';

// The fixed extension plan. Extension numbers are part of the product contract
// and must not be changed arbitrarily; credentials live in the environment.
const EXTENSIONS = Object.freeze({
  1001: Object.freeze({ number: '1001', name: 'Office' }),
  1002: Object.freeze({ number: '1002', name: 'Warehouse' }),
});

const PAGING_GROUPS = Object.freeze({
  700: Object.freeze({ number: '700', name: 'Page All', members: Object.freeze(['1001', '1002']) }),
  701: Object.freeze({ number: '701', name: 'Page Office', members: Object.freeze(['1001']) }),
  702: Object.freeze({ number: '702', name: 'Page Warehouse', members: Object.freeze(['1002']) }),
});

const ECHO_EXTENSION = '600';

const EXTENSION_NUMBERS = Object.freeze(Object.keys(EXTENSIONS));
const PAGING_GROUP_NUMBERS = Object.freeze(Object.keys(PAGING_GROUPS));

const isExtension = (n) => Object.prototype.hasOwnProperty.call(EXTENSIONS, n);
const isPagingGroup = (n) => Object.prototype.hasOwnProperty.call(PAGING_GROUPS, n);

/** Members of a paging group, excluding the caller (an extension never pages itself). */
function pagingTargets(group, callerExtension) {
  return PAGING_GROUPS[group].members.filter((m) => m !== callerExtension);
}

// Endpoint names: "1001" (browser) or "1001-phone" (physical phone).
function extensionFromEndpoint(endpoint) {
  const m = /^(\d{4})(?:-phone)?$/.exec(String(endpoint || ''));
  return m && isExtension(m[1]) ? m[1] : null;
}

// Channel names: "PJSIP/1001-0000002a" or "PJSIP/1001-phone-0000002a".
function extensionFromChannel(channel) {
  const m = /^PJSIP\/(\d{4})(?:-phone)?-[0-9a-f]+$/.exec(String(channel || ''));
  return m && isExtension(m[1]) ? m[1] : null;
}

module.exports = {
  EXTENSIONS,
  PAGING_GROUPS,
  ECHO_EXTENSION,
  EXTENSION_NUMBERS,
  PAGING_GROUP_NUMBERS,
  isExtension,
  isPagingGroup,
  pagingTargets,
  extensionFromEndpoint,
  extensionFromChannel,
};
