// Item / detail factories shared by the v2 adapters.
//
// Every item in a snapshot follows CONTRACT §2.1 + §7.3: `id = <manager>:<packageId>`,
// a `kind` of `app | pkg | ext`, the manager's groupId, and the light online fields
// (`sizeBytes: null`, no per-item subprocess). Adapters only provide name/version/path.

/**
 * Build one snapshot item for a manager descriptor.
 *
 * @param {object} def catalog descriptor (`lib/catalog.js`)
 * @param {{name?:string, packageId:string, version?:string, latest?:string|null,
 *   hasUpdate?:boolean, path?:string|null, description?:string|null, source?:string|null,
 *   scope?:string|null, note?:string|null, managerVersion?:string|null}} fields
 * @returns {object} contract item
 */
export function makeItem(def, fields) {
  const packageId = String(fields.packageId);
  const item = {
    id: `${def.id}:${packageId}`,
    manager: def.id,
    groupId: def.groupId,
    kind: def.itemKind,
    name: fields.name ? String(fields.name) : packageId,
    packageId,
    source: fields.source || def.id,
    scope: fields.scope || def.scopeLabel,
    cwd: null,
    path: fields.path || null,
    version: fields.version ? String(fields.version) : '',
    latest: fields.latest === undefined ? null : fields.latest,
    hasUpdate: fields.hasUpdate === true,
    description: fields.description || null,
    sizeBytes: null,
    installedAt: null,
    managerVersion: fields.managerVersion || null,
  };
  if (fields.note) item.note = fields.note;
  return item;
}

/**
 * Minimal `detail` payload for managers whose installed artifacts cannot be inspected on
 * disk (cargo / uv / pip / gem / dotnet / go / editor extensions): everything the drawer
 * needs to render, with honest `null`s instead of invented values.
 *
 * @param {object} def catalog descriptor
 * @param {object} item snapshot item
 * @returns {object} contract detail payload
 */
export function makeDetail(def, item) {
  return {
    id: item.id,
    manager: def.id,
    packageId: item.packageId,
    name: item.name,
    version: item.version || '',
    source: item.source || def.id,
    description: item.description || null,
    sizeBytes: item.sizeBytes === undefined ? null : item.sizeBytes,
    path: item.path || null,
    license: null,
    homepage: null,
    repository: null,
    publisher: null,
    dependencies: [],
    dependents: [],
    installedAt: null,
    otherVersions: null,
  };
}
