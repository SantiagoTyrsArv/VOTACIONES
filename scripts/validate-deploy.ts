import assert from 'node:assert/strict';
import {
  createRailwayContext,
  project,
  validateGraph,
  type ResourceNode,
  type ServiceNode,
} from 'railway/iac';
import configuration from '../.railway/railway.js';
const definition = await configuration(
  createRailwayContext({ environment: 'production' }),
  project,
);
const resources = (definition.resources || []).flat() as ResourceNode[];
assert.deepEqual(
  validateGraph({
    version: 1,
    project: { name: definition.name },
    environments: [],
    resources,
    edges: [],
  }),
  [],
);
const services = resources.filter((r): r is ServiceNode => r.type === 'service');
assert.equal(services.find((s) => s.name === 'votaciones')?.deploy?.numReplicas, 8);
assert.equal(services.find((s) => s.name === 'redis')?.deploy?.numReplicas, 1);
console.log(
  JSON.stringify({
    validation: 'SDK local; sin plan ni despliegue remoto',
    resources: resources.map((r) => r.address),
    replicas: 8,
  }),
);
