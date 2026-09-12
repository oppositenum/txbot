const test = require('node:test');
const assert = require('node:assert/strict');
const { FarmClient } = require('../src/client');
const { PastureClient, PetClient, GoldClient } = require('../src/plugins');

test('农场任务、种子袋和仓库解析支持z参数在业务参数前', async () => {
  const client = new FarmClient('');
  client.req = async (path) => {
    if (path === 'taskOrders.do') return '<a href="orderInfo.do?z=t&amp;taskId=42">日常任务</a>';
    if (path.startsWith('myBag.do')) return '水晶兰(12粒)<a href="sowSeedsAll.do?z=t&amp;seedsId=104">种植</a>';
    if (path.startsWith('myStore.do')) return '水晶兰(8)<a href="lock.do?z=t&amp;seedsId=104&amp;lock=0&amp;pn=1">锁</a>总价:960';
    throw new Error(path);
  };
  assert.deepEqual(await client.getTasks(), [{ taskId: 42, name: '日常任务' }]);
  assert.deepEqual(await client.getBag(), [{ name: '水晶兰', count: 12, seedsId: 104 }]);
  assert.deepEqual(await client.getStore(), { totalValue: 960, items: [{ name: '水晶兰', count: 8, seedsId: 104, locked: true }] });
});

test('推荐种植和商店种子目录解析支持动态z参数', async () => {
  const client = new FarmClient('');
  client.req = async (path) => {
    if (path === 'myInfo.do') return '推荐种植:<a href="seedsInfo.do?z=t&amp;seedsId=104">等级种子</a>';
    if (path === 'seedsInfo.do?seedsId=104') return '种子详细介绍 水晶兰 种子价格:100金币 果实售价:200金币 所需等级:1级';
    if (path.startsWith('shop.do')) return '水晶兰:1级 单价:100金币<a href="seedsInfo.do?z=t&amp;seedsId=104">[购买]</a>';
    throw new Error(path);
  };
  assert.equal((await client.getRecommendedSeed()).seedsId, 104);
  assert.deepEqual(FarmClient.parseShopItems(await client.req('shop.do?category=0&lv=0&pn=1')), [{ name: '水晶兰', level: 1, price: 100, seedsId: 104 }]);
});

test('牧场和圣衣链接解析支持动态z参数', async () => {
  const pasture = new PastureClient('');
  pasture.req = async () => '<strong>雌舍1:大象(收获期)</strong><a href="harvest.do?z=t&amp;id=7">收获</a><a href="myFemales.do?z=t&amp;id=8">补栏</a><a href="feedConfirm.do?z=t&amp;id=9&amp;uid=1">喂食</a><a href="clean.do?z=t&amp;id=9&amp;from=1">洗澡</a>';
  const info = await pasture.getInfo();
  assert.deepEqual(info.harvestable, [7]);
  assert.deepEqual(info.idleCorrals, [8]);
  assert.equal(info.needFeed, 1);

  const gold = new GoldClient('');
  gold.req = async () => '新手试练场(0级)<a href="areaDig.do?z=t&amp;id=3">进入</a>';
  assert.deepEqual(await gold.getAreaList(), [{ name: '新手试练场', level: 0, mapId: 3 }]);
});

test('宠物劳动收获链接支持动态z参数', async () => {
  const pet = new PetClient('');
  pet.req = async () => '<a href="harvest.do?z=t&amp;tpi=0&amp;ht=1&amp;gid=2&amp;pp=3">收获</a>';
  let called = null;
  const originalReq = pet.req;
  pet.req = async (path) => { if (path.startsWith('harvest.do')) called = path; return originalReq(path); };
  assert.equal(await pet.harvestWork(), 1);
  assert.equal(called, 'harvest.do?z=t&tpi=0&ht=1&gid=2&pp=3');
});

test('好友土地和留言链接支持动态z参数', async () => {
  const client = new FarmClient('');
  client.req = async (path) => {
    if (path === 'friendLand.do') return '<a href="harvestFriendLand.do?z=t&amp;landId=11">收割</a><a href="waterFriendLand.do?z=t&amp;landId=12&amp;tuid=99">浇水</a><a href="killFriendInsects.do?z=t&amp;landId=13">杀虫</a>';
    if (path.includes('commonReceiveManage')) return '<a href="/im/cs/commonReceiveDetail.do?z=t&amp;id=71">留言</a>';
    throw new Error(path);
  };
  assert.deepEqual(await client.getFriendLandTasks(), [
    { landId: '11', canHarvest: true, needDig: false, needKill: false, needWeed: false, needWater: false, tuid: null },
    { landId: '13', canHarvest: false, needDig: false, needKill: true, needWeed: false, needWater: false, tuid: null },
    { landId: '12', canHarvest: false, needDig: false, needKill: false, needWeed: false, needWater: true, tuid: '99' },
  ]);
  assert.deepEqual(await client.getMessagePage(), [71]);
});
