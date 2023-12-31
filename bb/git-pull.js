let $ = {};
const argsSchema = [
  ['github', 'curzonj'],
  ['repository', 'bitburner-scripts'],
  ['file', []],
  ['path', 'bb'],
  ['ref', 'main'],
  ['extension', ['.js']], // Files to download by extension
];

function buildClient(ns) {
  const apiToken = ns.read("/api_token.txt");
  return function(url, opts={}) {
    opts.headers ||= {};
    opts.headers["Authorization"] = `Bearer ${apiToken}`;
    return fetch(url, opts);
  }
}

export async function main(ns) {
  $.request = buildClient(ns);
  $.options = ns.flags(argsSchema);
  $.ref = ns.args[0] || $.options.ref;

  const baseUrl = `raw.githubusercontent.com/${$.options.github}/${$.options.repository}/${$.ref}/`;
  const files = $.options.file.length > 0 ? $.options.file : await repositoryListing($.options.path);

  await Promise.all(files.map(path => {
    const url = `https://${baseUrl}/${path}`;
    return ns.wget(url, path).catch(e => ns.tprint(`Failed to download ${path}`));
  }));

  ns.tprint(`INFO: Pull complete.`);
}

async function repositoryListing(folder = '') {
  const listUrl = `https://api.github.com/repos/${$.options.github}/${$.options.repository}/contents/${folder}?ref=${$.ref}`
  const response = await $.request(listUrl);
  const payload = await response.json();
  const folders = payload.filter(f => f.type == "dir").map(f => f.path);
  let files = payload.filter(f => f.type == "file").map(f => f.path)
    .filter(f => $.options.extension.some(ext => f.endsWith(ext)));
  for (const folder of folders)
    files = files.concat(await repositoryListing(folder));
  return files;
}
