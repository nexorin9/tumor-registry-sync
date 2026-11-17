import { createServer } from 'node:http';
import { resolvePathMap, collectHospitalValues, loadPathMap } from '../dist/diff/path-map.js';
import { parseCondition } from '../dist/fhir/parse.js';
import { lookupRows } from '../dist/fhir/orchestrator.js';
import { FhirClient } from '../dist/fhir/client.js';

function bundle(entries) {
  return JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: entries.length, link: [], entry: entries.map((r) => ({ resource: r })) });
}
const records = [
  { id: 'P1', identifier: 'REG-DEMO-002', conditions: [{ code: 'IIIC', stage: 'IIIC', onsetDateTime: '2024-05-20' }], encounters: [{ periodStart: '2024-05-20' }] },
];
const server = createServer((req, res) => {
  const url = new URL(`http://127.0.0.1:18130${req.url}`);
  const seg = url.pathname.split('/').filter(Boolean);
  const rt = seg[seg.length - 1];
  let entries = [];
  if (rt === 'Patient') {
    const tok = (url.searchParams.get('identifier') || '').split('|')[1];
    entries = records.filter((r) => r.identifier === tok).map((r) => ({ resourceType: 'Patient', id: r.id, identifier: [{ system: 'urn:oid:1.2.3', value: r.identifier }] }));
  } else if (rt === 'Condition') {
    const pid = (url.searchParams.get('subject') || '').replace('Patient/', '');
    const rec = records.find((r) => r.id === pid);
    if (rec) entries = rec.conditions.map((c, i) => ({ resourceType: 'Condition', id: `cond-${pid}-${i}`, subject: { reference: `Patient/${pid}` }, code: { text: c.code }, stage: { text: c.stage }, onsetDateTime: c.onsetDateTime }));
  } else if (rt === 'Encounter') {
    const pid = (url.searchParams.get('patient') || '').replace('Patient/', '');
    const rec = records.find((r) => r.id === pid);
    if (rec) entries = rec.encounters.map((e, i) => ({ resourceType: 'Encounter', id: `enc-${pid}-${i}`, subject: { reference: `Patient/${pid}` }, period: { start: e.periodStart } }));
  }
  res.writeHead(200, { 'content-type': 'application/fhir+json' });
  res.end(bundle(entries));
});
await new Promise((r) => server.listen(18130, '127.0.0.1', r));

const client = new FhirClient({ baseUrl: 'http://127.0.0.1:18130', apiToken: 't', identifierSystem: 'urn:oid:1.2.3' });
const result = await lookupRows([{ rowNumber: 2, registryId: 'REG-DEMO-002' }], client, {});
const out = result.rows[0];
console.log('binding=', out.binding);
console.log('conditions=', JSON.stringify(out.conditions));
console.log('encounters=', JSON.stringify(out.encounters));
const pathMap = loadPathMap(new URL('../config/path-map.json', import.meta.url).pathname);
const fieldSpec = JSON.parse((await import('node:fs')).readFileSync(new URL('../config/field-spec.json', import.meta.url).pathname, 'utf8'));
const resolution = resolvePathMap(fieldSpec, pathMap, ['登记号','分期','治疗方案','随访电话','生活方式备注']);
const hv = collectHospitalValues(resolution, { patient: out.patient, conditions: out.conditions, encounters: out.encounters }, {});
console.log('hospitalValues=', JSON.stringify(hv.values));
server.close();
