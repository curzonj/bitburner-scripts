import { allServers, validTargets, bestGrindTarget } from 'bb/lib.js'

/** @param {NS} ns */
export async function main(ns) {
  const homeMaxRam = ns.getServerMaxRam("home");
  const flagArgs = ns.flags([
    ['home', false],
    ['debug', false],
    ['trace', false],
    ['tail', false],
    ['grind', false],
    ['margin',200],
    ['reserved', 0],
    ['steal', 0.4],
    ['memoryOversubscription', 0.2],
    ['concurrency', 2],
    ['target', []],
  ]);

  if (flagArgs.trace) {
    flagArgs.debug = true;
    ns.disableLog("disableLog");
    ns.disableLog("scan");
    ns.disableLog("scp");
    ns.disableLog("getServerRequiredHackingLevel");
  } else {
    ns.disableLog("ALL");
  }

  const home = ns.getServer("home");
  const servers = allServers(ns)
    .map(s => ns.getServer(s))
    .filter(s => s.hasAdminRights)
    .reduce((acc, s) => {
      acc[s.hostname] = s;
      return acc;
    }, {});

  function getTotalMemoryInUse() {
    return Object.keys(servers).reduce(function (acc, name) {
      return acc + ns.getServerUsedRam(name);
    }, 0);
  }

  function getTotalMemoryInstalled() {
    return Object.keys(servers).reduce(function (acc, name) {
      return acc + ns.getServerMaxRam(name);
    }, 0);
  }

  const reservedMemory = flagArgs.reserved;
  const margin = flagArgs.margin;
  const cpuCores = flagArgs.home ? home.cpuCores : 1;
  const memoryBudget = {};
  const memoryUsedElsewhere = getTotalMemoryInUse();
  const selfMemReq = ns.getScriptRam("/bb/scheduler.js");

  if (memoryUsedElsewhere > (reservedMemory+selfMemReq)) {
    ns.tprint("Too much memory used elsewhere ", ns.formatRam(memoryUsedElsewhere));
    ns.exit();
  }

  const rpcHack = "/bb/rpc-hack.js";
  const rpcGrow = "/bb/rpc-grow.js";
  const rpcWeaken = "/bb/rpc-weaken.js";
  const rpcMemReqs = {};
  const rpcFuncs = [rpcHack, rpcGrow, rpcWeaken];
  rpcFuncs.forEach(function (n) {
    rpcMemReqs[n] = ns.getScriptRam(n);
  });
  const maxRpcMemReq = Math.max.apply(null, Object.values(rpcMemReqs));
  const maxHomeThreads = Math.floor(home.maxRam / maxRpcMemReq);

  (function () {
    for (var name in servers) {
      ns.scp(rpcHack, name);
      ns.scp(rpcGrow, name);
      ns.scp(rpcWeaken, name);
    }
  })();

  if (flagArgs.tail) {
    ns.tail();
    ns.moveTail(0, 0);
  }

  async function spawnThreads(rpc, threads, arg) {
    let remaining = Math.ceil(threads);
    const { freeMem } = procStats();
    const memRequired = rpcMemReqs[rpc] * threads;

    let pool = Object.keys(servers).map(function (name) {
      return ns.getServer(name);
    }).filter(function (server) {
      return server.maxRam > 0;
    }).sort(function (a, b) {
      return (a.maxRam - a.ramUsed) - (b.maxRam - b.ramUsed);
    });

    if (flagArgs.home) {
      pool = [ns.getServer("home")];
    }

    for (var i in pool) {
      var s = pool[i];
      var name = s.hostname;
      let maxRam = s.maxRam;
      if (name == "home") {
        maxRam -= reservedMemory;
      }

      let maxLocalThreads = Math.floor((maxRam - s.ramUsed) / rpcMemReqs[rpc])
      let localThreads = remaining;

      if (rpc == rpcWeaken || rpc == rpcGrow) {
        localThreads = Math.min(remaining, maxLocalThreads);
      } else if (localThreads > maxLocalThreads) {
        if (i == pool.length -1) {
          // If this is the biggest we have available, just use what ever we can.
          localThreads = maxLocalThreads;
        } else {
          continue;
        }
      }

      if (localThreads < 1) {
        continue;
      }

      remaining -= localThreads;
      if (arg == "home") {
        // trigger a stacktrace
        localThreads = -1;
      }
      ns.exec(rpc, name, localThreads, arg);
    }

    if (remaining < 1) {
      return true;
    } else {
      ns.print("ERROR: spawn failed ", { rpc, threads, remaining, arg, required: ns.formatRam(memRequired), free: ns.formatRam(freeMem) });
      return false;
    }
  }

  function procStats() {
    let freeMem = 0;
    let procs = 0;

    for (var name in servers) {
      let s = ns.getServer(name);
      freeMem += (s.maxRam - s.ramUsed);
      procs += ns.ps(name).length;
    }

    return { freeMem: freeMem, procs };;
  }

  async function monitoringLoop() {
    while (true) {
      const { freeMem, procs } = procStats();
      ns.print({ freeMem: ns.formatRam(freeMem), procs });
      await ns.asleep(5000);
    }
  }

  async function listen(portNumber, fn) {
    const port = ns.getPortHandle(portNumber);
    port.clear();

    while (true) {
      if (port.empty()) {
        await port.nextWrite();
      }

      let data = port.read();
      if (data != "NULL PORT DATA") {
        await fn(data);
      }
    }
  }

  async function remotePrintLogging() {
    await listen(3, function (data) {
      ns.print(data);
    });
  }

  async function remoteDebugLogging() {
    await listen(2, function (data) {
      if (flagArgs.debug) {
        ns.print(data);
      }
    });
  }

  async function remoteTraceLogging() {
    await listen(1, function (data) {
      if (flagArgs.trace) {
        ns.print(data);
      }
    });
  }

  async function loop(name) {
    if (
      ns.getServerMaxMoney(name) == 0 ||
      name == "home" ||
      name.startsWith("pserv")
    ) {
      return;
    }

    const myLevel = ns.getHackingLevel();
    while (ns.getServerRequiredHackingLevel(name) > myLevel/2) {
      await ns.asleep(60000);
    }

    let batchID = 0;
    while (true) {
      let s = ns.getServer(name);
      let nextSleep = margin * 4;

      if (s.hackDifficulty > (s.minDifficulty * 1.01)) {
        nextSleep += ns.getWeakenTime(name);
      }

      const batchLength = ns.getWeakenTime(name) + (margin * 4);
      nextSleep = Math.max(nextSleep, batchLength / flagArgs.concurrency);

      let prom = batch(batchID++, name);
      if (flagArgs.once) {
        return prom;
      }

      await Promise.race([
        prom,
        ns.asleep(nextSleep),
      ]);
    }
  }

  function calculateThreads(name) {
    const myLevel = ns.getHackingLevel();
    if (ns.getServerRequiredHackingLevel(name) > myLevel) {
      return null;
    }

    const moneyMax = ns.getServerMaxMoney(name);
    const moneyAvailable = ns.getServerMoneyAvailable(name);
    const hackDifficulty = ns.getServerSecurityLevel(name);
    const minDifficulty = ns.getServerMinSecurityLevel(name);

    const growFirst = moneyAvailable < moneyMax * 0.95;
    const hackPercentage = flagArgs.steal;
    let growthFactor = (1 / (1 - (hackPercentage * 1.25)));
    if (growFirst) {
      growthFactor = moneyMax / Math.max(moneyAvailable, 1);
    }

    const threads = {
      hack: Math.ceil(hackPercentage / ns.hackAnalyze(name)),
      grow: Math.min(maxHomeThreads, Math.ceil(ns.growthAnalyze(name, growthFactor, cpuCores))),
    }

    const growthAnalyze = ns.growthAnalyzeSecurity(threads.grow, undefined, cpuCores);
    const weakenAnalyze = ns.weakenAnalyze(1, cpuCores);
    const hackAnalyze = ns.hackAnalyzeSecurity(threads.hack, name);

    threads.growWeaken = Math.ceil(growthAnalyze / weakenAnalyze);
    threads.hackWeaken = Math.ceil(hackAnalyze / weakenAnalyze)
    threads.prepWeaken = Math.ceil((hackDifficulty - minDifficulty) / weakenAnalyze);

    const budget = (
      rpcMemReqs[rpcWeaken] * threads.prepWeaken +
      rpcMemReqs[rpcWeaken] * threads.growWeaken +
      rpcMemReqs[rpcWeaken] * threads.hackWeaken +
      rpcMemReqs[rpcGrow] * threads.grow +
      rpcMemReqs[rpcHack] * threads.hack
    );

    if (budget < 1 || budget == null || !isFinite(budget) || isNaN(budget)) {
      ns.tprint({ threads, growthAnalyze, weakenAnalyze, hackAnalyze, growthFactor });
      ns.tprint(ns.sprintf("ERROR: Failed to build budget for %s", name));
      return null;
    }

    memoryBudget[name] = Math.ceil(budget);

    return threads;
  }

  function calculateTimes(name) {
    const times = {};

    times.weakenTime = ns.getWeakenTime(name);
    times.hackTime = ns.getHackTime(name);
    times.growTime = ns.getGrowTime(name);

    times.growLead = times.weakenTime - times.growTime - margin;
    times.hackLead = times.weakenTime - times.hackTime - margin * 3;
    times.weakenLead = margin * 2;
    times.trailingMargin = margin * 4;

    return times;
  }

  async function batch(batchID, name) {
    let s = ns.getServer(name);

    function log(src, argv) {
      argv['batchID'] = batchID;
      argv['name'] = name;
      ns.print("loop." + src + " ", argv);
    }

    const times = calculateTimes(name);
    const threads = calculateThreads(name);

    if (threads == null) {
      return;
    }

    const stats = { minDifficulty: s.minDifficulty, difficulty: s.hackDifficulty, money: s.moneyAvailable, max: s.moneyMax };
    if (flagArgs.debug) {
      log('threads', threads);
      log("start", stats);
    }
    if (s.hackDifficulty > (s.minDifficulty * 1.01)) {
      await spawnThreads(rpcWeaken, threads.prepWeaken, name);
      ns.print(ns.sprintf("weakening %s for %s", name, ns.tFormat(times.weakenTime)));
      await ns.asleep(times.weakenTime + margin);
    } else if (s.moneyAvailable < s.moneyMax * 0.95) {
      await spawnThreads(rpcWeaken, threads.growWeaken, name);
      await ns.asleep(times.growLead);
      await spawnThreads(rpcGrow, threads.grow, name);
      await ns.asleep(times.growTime + (margin * 2));
      ns.print(ns.sprintf("growing %s for %s", name, ns.tFormat(times.weakenTime)));
    } else {
      await spawnThreads(rpcWeaken, threads.hackWeaken, name);
      await ns.asleep(margin * 2);
      await spawnThreads(rpcWeaken, threads.growWeaken, name);
      await ns.asleep(times.growLead);
      await spawnThreads(rpcGrow, threads.grow, name);
      await ns.asleep(times.hackLead - times.growLead);
      await spawnThreads(rpcHack, threads.hack, name);
      await ns.asleep(times.hackTime + times.trailingMargin);
    }

    if (flagArgs.debug) {
      s = ns.getServer(name);
      log("end", { minDifficulty: s.minDifficulty, difficulty: s.hackDifficulty, money: s.moneyAvailable, max: s.moneyMax });
    }
  }

  function calcGrindingThreads() {
    const memCommitted = Object.keys(memoryBudget).reduce(function (acc, name) {
      const num = memoryBudget[name];
      return acc + num;
    }, 0);
    const totalMem = getTotalMemoryInstalled();
    const memRequired = rpcMemReqs[rpcWeaken];
    return (totalMem - (memCommitted * (1 - flagArgs.memoryOversubscription))) / memRequired;
  }

  async function grindHackingExperience() {
    while (true) {
      let target = bestGrindTarget(ns);
      let threads = calcGrindingThreads();
      let time = ns.getWeakenTime(target);

      if (!target) {
        await ns.asleep(60000);
        continue;
      }

      await spawnThreads(rpcWeaken, threads, target);
      await ns.asleep(time + margin);
    }
  }

  remoteDebugLogging();
  remoteTraceLogging();
  remotePrintLogging();
  monitoringLoop();

  // Let the monitoring loops get started
  await ns.asleep(10);

  // main body
  const targets = flagArgs.target.length > 0 ? flagArgs.target : validTargets(ns);
  await Promise.all([
    targets.map(function (name) {
      calculateThreads(name);
      return loop(name);
    }),
    flagArgs.grind ? grindHackingExperience() : [],
  ].flat());
}
