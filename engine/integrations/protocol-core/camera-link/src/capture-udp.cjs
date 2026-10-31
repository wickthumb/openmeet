'use strict';
// Original bounded reader from the reviewed release; no imports or I/O.
const sharedByteLength = typeof SharedArrayBuffer === 'undefined' ? null :
  Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength').get;
const viewBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
function hasSharedBacking(bytes) {
  if (!sharedByteLength) return false;
  // The intrinsic getter checks backing-store internal slots across realms.
  const backing = viewBuffer.call(bytes);
  try { sharedByteLength.call(backing); return true; }
  catch { return false; }
}
function readCaptureUdp(bytes) {
  if (!(bytes instanceof Uint8Array) || hasSharedBacking(bytes)) throw new TypeError('Nonshared Buffer or Uint8Array required');
  function fatal(reason, offset) { const e = new Error(reason + ' at ' + offset); e.code = 'ERR_CAPTURE_FORMAT'; e.reason = reason; e.offset = offset; throw e; }
  if (bytes.byteLength > 67108864) fatal('size-limit', 0);
  const b = Buffer.alloc(bytes.byteLength); b.set(bytes);
  const result = { format: '', observations: [], diagnostics: [], packetRecords: 0, sectionCount: 0, containerUnits: 0 };
  function unit(o) { if (result.containerUnits === 100000) fatal('unit-limit', o); result.containerUnits++; }
  function lengths(cap, orig, snap, o) { if (cap > orig) fatal('captured-over-original', o); if (snap && cap > snap) fatal('captured-over-snaplen', o); }
  function packet(p, orig, link, meta) {
    result.packetRecords++;
    meta.recordOrdinal = result.packetRecords;
    const skip = reason => result.diagnostics.push({kind:'packet-skip',offset:meta.recordOffset,recordOrdinal:meta.recordOrdinal,reason});
    if (link !== 1) return skip('unsupported-link');
    if (p.length < 14) return skip('ethernet-short');
    let pos = 14, type = p.readUInt16BE(12); const tags = [];
    while (type === 0x8100 || type === 0x88a8) {
      if (tags.length === 2) return skip('vlan-limit');
      if (p.length - pos < 4) return skip('vlan-short');
      tags.push(p.readUInt16BE(pos)); type = p.readUInt16BE(pos+2); pos += 4;
    }
    if (type !== 0x0800) return skip('unsupported-ethertype');
    if (p.length-pos < 20) return skip('ipv4-short');
    if (p[pos] >>> 4 !== 4) return skip('ipv4-version');
    const ihl = (p[pos]&15)*4;
    if (ihl < 20) return skip('ipv4-ihl');
    if (p.length-pos < ihl) return skip('ipv4-header-short');
    const total = p.readUInt16BE(pos+2);
    if (total < ihl) return skip('ipv4-total-length');
    if (total > p.length-pos) return skip('ipv4-incomplete');
    const frag = p.readUInt16BE(pos+6);
    if (frag & 0x8000) return skip('ipv4-reserved-flag');
    if (frag & 0x3fff) return skip('ipv4-fragment');
    if (p[pos+9] !== 17) return skip('unsupported-protocol');
    const size = total-ihl, u = pos+ihl;
    if (size < 8) return skip('udp-short');
    const len = p.readUInt16BE(u+4);
    if (len < 8) return skip('udp-length-small');
    if (len !== size) return skip('udp-length-mismatch');
    const sp = p.readUInt16BE(u), dp = p.readUInt16BE(u+2);
    if (!sp || !dp) return skip('zero-port');
    if (sp !== 41925 && dp !== 41925) return skip('port-filter');
    const payload = Buffer.alloc(len-8); payload.set(p.subarray(u+8,u+len));
    const address = at => Array.from(p.subarray(pos+at,pos+at+4)).join('.');
    result.observations.push({...meta,bytes:payload,sourceAddress:address(12),sourcePort:sp,destinationAddress:address(16),destinationPort:dp,frameTruncated:p.length<orig,checksumsVerified:false,vlanTags:tags});
  }
  if (b.length < 4) fatal('magic',0);
  const magic = b.subarray(0,4).toString('hex');
  const classic = {'d4c3b2a1':[true,'microseconds'], 'a1b2c3d4':[false,'microseconds'], '4d3cb2a1':[true,'nanoseconds'], 'a1b23c4d':[false,'nanoseconds']}[magic];
  if (classic) {
    result.format='pcap';result.sectionCount=1;
    if (b.length<24) fatal('global-header-short',0);
    const [le,precision]=classic, u16=o=>le?b.readUInt16LE(o):b.readUInt16BE(o), u32=o=>le?b.readUInt32LE(o):b.readUInt32BE(o);
    if(u16(4)!==2 || u16(6)!==4) fatal('pcap-version',0);
    const snap=u32(16),link=u32(20)&65535;
    if(!snap) fatal('snaplen-zero',0);
    for(let o=24;o<b.length;) {
      if(b.length-o<16) fatal('record-header-short',o);
      unit(o);
      const seconds=u32(o),fraction=u32(o+4),cap=u32(o+8),orig=u32(o+12);
      if(fraction >= (precision==='microseconds'?1000000:1000000000)) fatal('fraction-range',o);
      lengths(cap,orig,snap,o);
      if(cap>b.length-o-16) fatal('record-extent',o);
      packet(b.subarray(o+16,o+16+cap),orig,link,{recordOffset:o,sectionIndex:0,interfaceId:0,timestampRaw:{seconds,fraction,precision}});
      o+=16+cap;
    }
  } else if(magic==='0a0d0d0a') {
    result.format='pcapng'; let le=true, interfaces=[];
    for(let o=0;o<b.length;) {
      if(b.length-o<12) fatal('block-header-short',o);
      const shb=b.readUInt32BE(o)===0x0a0d0d0a;
      if(shb) {
        const bom=b.subarray(o+8,o+12).toString('hex');
        if(bom!=='4d3c2b1a' && bom!=='1a2b3c4d') fatal('section-byte-order',o);
        le=bom==='4d3c2b1a';
      }
      const u16=p=>le?b.readUInt16LE(p):b.readUInt16BE(p),u32=p=>le?b.readUInt32LE(p):b.readUInt32BE(p);
      const type=u32(o),len=u32(o+4);
      if(len<12 || len%4) fatal('block-length',o);
      if(len>b.length-o) fatal('block-extent',o);
      if(u32(o+len-4)!==len) fatal('block-trailer',o);
      unit(o);
      if(shb) {
        if(len<28) fatal('section-header-short',o);
        if(u16(o+12)!==1 || ![0,2].includes(u16(o+14))) fatal('pcapng-version',o);
        if(result.sectionCount===1024) fatal('section-limit',o);
        result.sectionCount++; interfaces=[];
      } else if(type===1) {
        if(len<20) fatal('interface-header-short',o);
        if(interfaces.length===4096) fatal('interface-limit',o);
        interfaces.push({link:u16(o+8),snap:u32(o+12)});
      } else if(type===6) {
        if(len<32) fatal('epb-header-short',o);
        const id=u32(o+8),cap=u32(o+20),orig=u32(o+24),iface=interfaces[id];
        if(!iface) fatal('unknown-interface',o);
        lengths(cap,orig,iface.snap,o);
        if(Math.ceil(cap/4)*4>len-32) fatal('epb-packet-extent',o);
        packet(b.subarray(o+28,o+28+cap),orig,iface.link,{recordOffset:o,sectionIndex:result.sectionCount-1,interfaceId:id,timestampRaw:{high:u32(o+12),low:u32(o+16),precision:'uninterpreted'}});
      } else result.diagnostics.push({kind:'block-skip',offset:o,blockType:type,reason:type===2||type===3?'unsupported-packet-block':'unknown-block'});
      o+=len;
    }
  } else fatal('magic',0);
  return result;
}
module.exports={readCaptureUdp};
