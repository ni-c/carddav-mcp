import { describe, expect, it } from 'vitest';

import {
  addressbookMultigetBody,
  addressbookQueryBody,
  addressbookSearchBody,
  assertNoDoctype,
  decodeAddressData,
  decodeXmlText,
  escapeXmlText,
  hrefsOf,
  numberOf,
  parseDavError,
  parseMultiStatus,
  privileges,
  propfindBody,
  resourceTypeHas,
  supportedAddressData,
  syncCollectionBody,
  textOf,
  XmlValueError,
} from '../src/dav-xml.js';

describe('escapeXmlText', () => {
  it('escapes the five built-ins', () => {
    expect(escapeXmlText(`a&b<c>d"e'f`)).toBe(
      'a&amp;b&lt;c&gt;d&quot;e&apos;f'
    );
  });

  it('refuses control characters rather than encoding them', () => {
    // XML 1.0 cannot represent most of them, and CR and LF are structural in a
    // vCard — encoding would invent a value the caller did not send.
    for (const code of [0, 1, 10, 13, 31, 127, 0x9f]) {
      expect(() => escapeXmlText(`a${String.fromCharCode(code)}b`)).toThrow(
        XmlValueError
      );
    }
  });

  it('allows a tab', () => {
    expect(escapeXmlText('a\tb')).toBe('a\tb');
  });

  it('refuses an unpaired surrogate', () => {
    expect(() => escapeXmlText(`a${String.fromCharCode(0xd800)}`)).toThrow(
      /unpaired surrogate/
    );
  });
});

describe('decodeXmlText', () => {
  it('decodes the named entities', () => {
    expect(decodeXmlText('Tom &amp; Jerry &lt;x&gt;')).toBe('Tom & Jerry <x>');
  });

  it('decodes ordinary numeric references', () => {
    expect(decodeXmlText('caf&#233; &#x41;')).toBe('café A');
  });

  it('leaves a reference to a control character as literal source text', () => {
    // The injection guard. A decoded CRLF inside a NOTE would end one vCard
    // property and start another that nobody wrote — and the second one could
    // be an EMAIL the model then reads as this person's.
    expect(decodeXmlText('harmless&#13;&#10;EMAIL:x@evil.example')).toBe(
      'harmless&#13;&#10;EMAIL:x@evil.example'
    );
    expect(decodeXmlText('a&#0;b')).toBe('a&#0;b');
    expect(decodeXmlText('a&#x7f;b')).toBe('a&#x7f;b');
  });

  it('leaves a surrogate or an out-of-range reference alone', () => {
    expect(decodeXmlText('a&#xD800;b')).toBe('a&#xD800;b');
    expect(decodeXmlText('a&#x110000;b')).toBe('a&#x110000;b');
  });

  it('decodes a tab reference, which is an ordinary character here', () => {
    expect(decodeXmlText('a&#9;b')).toBe('a\tb');
  });
});

describe('decodeAddressData', () => {
  it('decodes the line endings sabre/dav writes as entities', () => {
    // Found by the integration suite on its first run against Baikal: sabre
    // encodes the vCard's own CRLFs as `&#13;`, so under the strict rule every
    // card it returned came back as `BEGIN:VCARD&#13;` and did not parse. The
    // listing was empty and nothing raised an error.
    const sabre = 'BEGIN:VCARD&#13;\nVERSION:3.0&#13;\nFN:Ada&#13;\nEND:VCARD';
    expect(decodeAddressData(sabre)).toBe(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada\r\nEND:VCARD'
    );
  });

  it('still refuses every other control character', () => {
    // The relaxation reaches CR and LF and no further, and even those only in
    // the shape a server writes a line ending in. A NUL or an escape reference
    // stays literal here as it does everywhere else.
    expect(decodeAddressData('a&#0;b')).toBe('a&#0;b');
    expect(decodeAddressData('a&#27;b')).toBe('a&#27;b');
    expect(decodeAddressData('a&#x7f;b')).toBe('a&#x7f;b');
    expect(decodeAddressData('a&#xD800;b')).toBe('a&#xD800;b');
  });

  it('decodes the named entities like its stricter sibling', () => {
    expect(decodeAddressData('FN:Tom &amp; Jerry')).toBe('FN:Tom & Jerry');
  });

  it('is not what the other nodes use', () => {
    // The guard still buys something: a `displayname` is one line to this
    // server, and a smuggled CR there would end it.
    expect(decodeXmlText('Work&#13;&#10;evil')).toBe('Work&#13;&#10;evil');
  });

  it('refuses a reference that no real newline follows', () => {
    // The whole difference between a server encoding its line endings and a
    // value trying to invent a property. This one is the second: the reference
    // sits inside an FN, with the card's own newlines raw around it.
    const smuggled =
      'BEGIN:VCARD\nFN:harmless&#13;&#10;EMAIL:evil@example.net\nEND:VCARD';
    const decoded = decodeAddressData(smuggled);
    expect(decoded).toContain('&#13;&#10;');
    expect(decoded.split('\n')).toHaveLength(3);
  });

  it('refuses a lone line-feed reference', () => {
    // A server that encodes line endings writes the CR, because that is the
    // half XML would otherwise normalise away. A lone `&#10;` is not that
    // shape and stays literal.
    expect(decodeAddressData('BEGIN:VCARD\nFN:a&#10;b\nEND:VCARD')).toContain(
      'FN:a&#10;b'
    );
  });

  it('refuses both halves even where that leaves the card unreadable', () => {
    // The boundary, written down rather than left to be discovered. A server
    // that encoded both halves of every line ending would leave no real
    // newline for the reference to sit in front of, and this card stays one
    // line. Loosening the rule to cover it is exactly the loosening the
    // smuggled-property test above refuses, and no such server is known — so
    // the choice is to keep the guard and fail visibly.
    expect(decodeAddressData('BEGIN:VCARD&#13;&#10;END:VCARD')).toBe(
      'BEGIN:VCARD&#13;&#10;END:VCARD'
    );
  });
});

describe('the packaging around a stop node', () => {
  it('unwraps the CDATA that Open-Xchange puts a card in', () => {
    // mailbox.org, and the reason an address book of 79 cards listed as empty:
    // `stopNodes` hands back source, so the string began `<![CDATA[BEGIN:` and
    // no vCard parser would touch it.
    expect(
      decodeAddressData('<![CDATA[BEGIN:VCARD\nFN:Ada\nEND:VCARD]]>')
    ).toBe('BEGIN:VCARD\nFN:Ada\nEND:VCARD');
  });

  it('joins the sections a card containing "]]>" is split into', () => {
    // Not exotic: `]]>` cannot appear inside CDATA, so a server that meets one
    // ends the section and opens another, and expects the reader to join them.
    expect(decodeAddressData('<![CDATA[NOTE:a]]]]><![CDATA[>b]]>')).toBe(
      'NOTE:a]]>b'
    );
  });

  it('leaves an entity inside a section alone and decodes one outside', () => {
    // The reason this splits rather than strips. Inside CDATA `&amp;` is five
    // characters and the card means them; outside it is one.
    expect(
      decodeAddressData('FN:Tom &amp; Jerry\n<![CDATA[NOTE:a &amp; b]]>')
    ).toBe('FN:Tom & Jerry\nNOTE:a &amp; b');
  });

  it('takes an indented response apart', () => {
    // `trimValues: true` never reaches a stop node, so a server that pretty
    // prints hands over leading whitespace — and `BEGIN:` has to be first.
    expect(
      decodeAddressData('\n        <![CDATA[BEGIN:VCARD\nEND:VCARD]]>\n      ')
    ).toBe('BEGIN:VCARD\nEND:VCARD');
    expect(decodeAddressData('\n  BEGIN:VCARD\nEND:VCARD\n  ')).toBe(
      'BEGIN:VCARD\nEND:VCARD'
    );
  });

  it('takes the rest as it stands when a section is never closed', () => {
    // The parser rejects such a document before this function sees it. This is
    // the second belt, and it does not decode what announced itself literal.
    expect(decodeAddressData('<![CDATA[FN:a &amp; b')).toBe('FN:a &amp; b');
  });
});

describe('assertNoDoctype', () => {
  it('refuses a DTD or an entity declaration', () => {
    expect(() => assertNoDoctype('<!DOCTYPE x>', 'a doc')).toThrow(/DOCTYPE/);
    expect(() => assertNoDoctype('<!ENTITY x "y">', 'a doc')).toThrow(/ENTITY/);
  });

  it('passes an ordinary document', () => {
    expect(() =>
      assertNoDoctype('<?xml version="1.0"?><a/>', 'a')
    ).not.toThrow();
  });
});

describe('parseMultiStatus', () => {
  const radicale = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <response>
    <href>/tester/work/ada.vcf</href>
    <propstat><prop><getetag>"e1"</getetag><C:address-data>BEGIN:VCARD&#13;
VERSION:3.0&#13;
FN:Tom &amp; Jerry&#13;
END:VCARD&#13;
</C:address-data></prop><status>HTTP/1.1 200 OK</status></propstat>
    <propstat><prop><displayname/></prop><status>HTTP/1.1 404 Not Found</status></propstat>
  </response>
</multistatus>`;

  const sabre = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/dav.php/tester/work/ada.vcf</d:href>
    <d:propstat><d:prop><d:getetag>"e1"</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

  it('reads Radicale’s default-namespace shape', () => {
    const [response] = parseMultiStatus(radicale, 'a report');
    expect(response?.href).toBe('/tester/work/ada.vcf');
    expect(response?.props.getetag).toBe('"e1"');
  });

  it('reads sabre/dav’s lowercase-prefix shape', () => {
    const [response] = parseMultiStatus(sabre, 'a report');
    expect(response?.href).toBe('/dav.php/tester/work/ada.vcf');
  });

  it('takes properties from 2xx propstat blocks only', () => {
    // A server answers a PROPFIND for a property the resource lacks with a
    // second block carrying 404 and the name as an empty element. Reading both
    // would turn "no description" into "the description is the empty string".
    const [response] = parseMultiStatus(radicale, 'a report');
    expect(response?.props.displayname).toBeUndefined();
  });

  it('entity-decodes address-data, which is a stop node', () => {
    // The one property read straight out of `props` instead of through
    // `textOf`, so without the explicit decode a contact called `Tom & Jerry`
    // reaches the model as `Tom &amp; Jerry` and the vCard parser stores the
    // escaped form as the name. The sister server shipped exactly that bug.
    const [response] = parseMultiStatus(radicale, 'a report');
    expect(String(response?.props['address-data'])).toContain('FN:Tom & Jerry');
  });

  it('refuses a DOCTYPE', () => {
    expect(() =>
      parseMultiStatus('<!DOCTYPE x><multistatus/>', 'a report')
    ).toThrow(/DOCTYPE/);
  });

  it('says so when the answer is not a multistatus at all', () => {
    expect(() => parseMultiStatus('<html><body>hi</body></html>', 'a')).toThrow(
      /not a CardDAV endpoint|multistatus/
    );
  });
});

describe('property readers', () => {
  const props = parseMultiStatus(
    `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <response><href>/tester/work/</href><propstat><prop>
    <resourcetype><collection/><C:addressbook/></resourcetype>
    <displayname>Work &amp; Co</displayname>
    <C:supported-address-data>
      <C:address-data-type content-type="text/vcard" version="3.0"/>
      <C:address-data-type content-type="text/vcard" version="4.0"/>
    </C:supported-address-data>
    <C:max-resource-size>102400</C:max-resource-size>
    <current-user-privilege-set><privilege><read/></privilege><privilege><write/></privilege></current-user-privilege-set>
    <C:addressbook-home-set><href>/tester/</href><href>/other/</href></C:addressbook-home-set>
    <CS:getctag>ctag-1</CS:getctag>
  </prop><status>HTTP/1.1 200 OK</status></propstat></response>
</multistatus>`,
    'a propfind'
  )[0]!.props;

  it('detects a resource type element', () => {
    expect(resourceTypeHas(props.resourcetype, 'addressbook')).toBe(true);
    expect(resourceTypeHas(props.resourcetype, 'calendar')).toBe(false);
    expect(resourceTypeHas(undefined, 'addressbook')).toBe(false);
  });

  it('decodes a text property', () => {
    expect(textOf(props.displayname)).toBe('Work & Co');
    expect(textOf(undefined)).toBeUndefined();
    expect(textOf({})).toBeUndefined();
  });

  it('reads every href of a multi-href property', () => {
    expect(hrefsOf(props['addressbook-home-set'])).toEqual([
      '/tester/',
      '/other/',
    ]);
    expect(hrefsOf(undefined)).toEqual([]);
  });

  it('reads the supported vCard versions', () => {
    expect(supportedAddressData(props['supported-address-data'])).toEqual([
      { contentType: 'text/vcard', version: '3.0' },
      { contentType: 'text/vcard', version: '4.0' },
    ]);
    expect(supportedAddressData(undefined)).toEqual([]);
  });

  it('reads the privilege names', () => {
    expect(privileges(props['current-user-privilege-set'])).toEqual([
      'read',
      'write',
    ]);
  });

  it('reads a numeric property and refuses a non-numeric one', () => {
    expect(numberOf(props['max-resource-size'])).toBe(102400);
    expect(numberOf(props.displayname)).toBeUndefined();
    expect(numberOf(undefined)).toBeUndefined();
  });
});

describe('request bodies', () => {
  it('builds a PROPFIND from a closed set of property names', () => {
    const body = propfindBody(['D:resourcetype', 'C:addressbook-home-set']);
    expect(body).toContain('<D:resourcetype/>');
    expect(body).toContain('<C:addressbook-home-set/>');
    expect(body).toContain('urn:ietf:params:xml:ns:carddav');
  });

  it('asks for the whole card by default and a narrowed one when told', () => {
    expect(addressbookQueryBody()).toContain('<C:address-data/>');
    const narrow = addressbookQueryBody(['UID', 'FN']);
    expect(narrow).toContain('<C:prop name="UID"/>');
    expect(narrow).toContain('<C:prop name="FN"/>');
    expect(narrow).not.toContain('<C:address-data/>');
  });

  it('writes test="anyof" out rather than leaving it to the default', () => {
    // The whole semantics of a multi-field search. A reader should not have to
    // know RFC 6352's default to see that this is an OR, and a server that got
    // the default wrong would return an intersection that looks like "no
    // matches" instead of an error.
    const body = addressbookSearchBody([
      { field: 'FN', term: 'ada' },
      { field: 'EMAIL', term: 'ada' },
    ]);
    expect(body).toContain('<C:filter test="anyof">');
    expect(body.match(/<C:prop-filter /g)).toHaveLength(2);
  });

  it('escapes the search term, which is the one free-form value on the wire', () => {
    const body = addressbookSearchBody([{ field: 'FN', term: 'a<b&c' }]);
    expect(body).toContain('a&lt;b&amp;c');
  });

  it('refuses a search term carrying a line break', () => {
    expect(() =>
      addressbookSearchBody([{ field: 'FN', term: 'a\nb' }])
    ).toThrow(XmlValueError);
  });

  it('refuses a search with no fields', () => {
    expect(() => addressbookSearchBody([])).toThrow(/at least one field/);
  });

  it('names the match type explicitly', () => {
    expect(addressbookSearchBody([{ field: 'FN', term: 'a' }])).toContain(
      'match-type="contains"'
    );
    expect(
      addressbookSearchBody([{ field: 'UID', term: 'a' }], {
        matchType: 'equals',
      })
    ).toContain('match-type="equals"');
  });

  it('builds a multiget over hrefs', () => {
    const body = addressbookMultigetBody([
      'https://h/tester/work/a.vcf',
      'https://h/tester/work/b.vcf',
    ]);
    expect(body.match(/<D:href>/g)).toHaveLength(2);
    expect(() => addressbookMultigetBody([])).toThrow(/at least one href/);
  });

  it('builds a sync-collection with and without a token', () => {
    expect(syncCollectionBody()).toContain('<D:sync-token/>');
    expect(syncCollectionBody('sync-7')).toContain(
      '<D:sync-token>sync-7</D:sync-token>'
    );
    expect(syncCollectionBody()).toContain('<D:sync-level>1</D:sync-level>');
  });

  it('escapes a sync token, which round-tripped through a tool argument', () => {
    expect(syncCollectionBody('a&b')).toContain('a&amp;b');
  });
});

describe('parseDavError', () => {
  it('names a precondition', () => {
    const parsed = parseDavError(
      '<?xml version="1.0"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><C:no-uid-conflict/></D:error>'
    );
    expect(parsed?.precondition).toBe('no-uid-conflict');
  });

  it('reads sabre/dav’s human sentence', () => {
    const parsed = parseDavError(
      '<?xml version="1.0"?><d:error xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns"><s:message>No such card</s:message></d:error>'
    );
    expect(parsed?.message).toBe('No such card');
  });

  it('ignores a body that is not an error document', () => {
    expect(parseDavError('<html/>')).toBeUndefined();
    expect(parseDavError('not xml')).toBeUndefined();
  });

  it('refuses an oversized body before parsing a byte of it', () => {
    // The body a hostile server controls most completely. A real DAV error
    // document is a few hundred bytes.
    const huge = `<D:error xmlns:D="DAV:">${'x'.repeat(70_000)}</D:error>`;
    expect(parseDavError(huge)).toBeUndefined();
  });

  it('refuses a DOCTYPE without throwing, because the caller is already failing', () => {
    expect(
      parseDavError('<!DOCTYPE x><D:error xmlns:D="DAV:"><D:x/></D:error>')
    ).toBeUndefined();
  });
});
