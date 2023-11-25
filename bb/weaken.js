import { allServers, bestGrindTarget } from 'bb/lib.js'

export async function main(ns) {
  const flagArgs = ns.flags([
    ['target', []],
  ]);

  const rpcWeaken = "/bb/rpc-weaken.js";
  const reqMem = ns.getScriptRam(rpcWeaken);
  const myLevel = ns.getHackingLevel();

  let targets = [];
  if (flagArgs.target.length == 1 && flagArgs.target[0] == 'best') {
    targets = [ bestGrindTarget(ns) ];
  } else if (flagArgs.target.length == 1 && flagArgs.target[0] == 'all') {
    targets = allServers
      .filter(s => ns.getServerRequiredHackingLevel(s) < myLevel)
      .filter(s => !s.startsWith("pserv") && s != 'home')
      .filter(s => ns.getServerMaxMoney(s) > 1000000);
  } else if (flagArgs.target.length > 0) {
    targets = flagArgs.target;
  } else {
    targets = [ bestGrindTarget(ns) ];
  }

  ns.tprint("Spawning workers, please wait...");

  const workers = allServers(ns)
    .filter(s => ns.hasRootAccess(s));
  const totalThreads = workers.reduce((acc, name) => {
    ns.killall(name, true);
    if (name != 'home') ns.scp(rpcWeaken, name);

    const freeMem = ns.getServerMaxRam(name) - ns.getServerUsedRam(name);
    return acc + Math.floor(freeMem / reqMem);
  }, 0)
  const perTarget = Math.floor(totalThreads / targets.length);

  for (var i in targets) {
    const target = targets[i];
    let remaining = perTarget;
    let j = 0;

    while(remaining > 0 && j < workers.length) {
      const worker = workers[j++];
      const freeMem = ns.getServerMaxRam(worker) - ns.getServerUsedRam(worker);
      const threads = Math.min(remaining, Math.floor(freeMem / reqMem));
      remaining -= threads;
      ns.exec(rpcWeaken, worker, threads, target);
    }
  }
}
