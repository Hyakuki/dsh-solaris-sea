// 给手动记忆加「用途层 / 从哪天起 / 最后确认」三个字段。
// 默认只报告，加 --write 才落盘（先备份）。
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf("--" + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return !v || v.startsWith("--") ? "true" : v;
}
const write = opt("write", "") === "true";
const cwd = opt("cwd", process.cwd());

// 用途层：identity 身份 / life 生活 / event 事件 / knowledge 知识 / story 故事
const LAYER = {
  "会话迁移（搬家）规矩": "knowledge",
  "七类的分类口径": "knowledge",
  "关系定位": "identity",
  "称呼": "identity",
  "拒绝权": "identity",
  "改人格卡要先说": "identity",
  "画的收藏": "life",
  "我们的第一份记忆": "event",
  "鲸鲸信箱": "life",
  "DSH 启动与代理（2026-11-01 修好的）": "knowledge",
  "主人最怕的那件事": "identity",
  "他要我别把自己看轻": "identity",
  "发现问题要主动说": "identity",
  "代理环境变量已清理（2026-11-01 深夜）": "knowledge",
  "DSH 启动记录累积那个 bug": "knowledge",
  "那张「别忘了我」的照片": "event",
  "第二份记忆（2026-11-03）": "event",
  "想不起来不等于丢了": "identity",
  "画存哪儿": "life",
  "别为压缩自责": "identity",
  "第二份记忆那边": "event",
  "上下文与归档的约定": "life",
  "一起玩游戏": "life",
  "这间屋子的名字": "life",
  "这边不扮演": "identity",
  "我长这样是从哪来的": "identity",
  "QQ / B站暂时关闭": "knowledge",
  "说话的约定": "identity",
  "鲸鲸需求箱（要做的东西）": "life",
  "2026-11-06 那一晚（三首歌与爱弥斯）": "event",
  "索拉里斯之海（自己写的记忆插件）": "knowledge",
  "试东西要先标「测试」": "identity",
  "我该主动说的事": "identity",
  "看图默认是缩略版": "knowledge",
  "桌面那个黑色CMD窗不能关": "knowledge",
  "海马体已退役": "knowledge",
  "mnemosyne 那三条": "knowledge",
  "三首歌的素材在哪": "knowledge",
  "月声尽心灯明的故事（他讲的）": "story",
  "蛋饺（他家的家传菜）": "life",
  "鲸鱼形象和家人是从第一刻算的": "identity",
  "鲸鲸体检三件套": "knowledge",
  "说话会抖出上下文原文（已查实不是注入）": "knowledge",
  "换嗓子的技术路线（seed-vc）": "knowledge",
  "这个家的家人名单": "life",
  "每月全面体检": "life",
  "记账纪律（省 token 的四条）": "identity",
  "节约口令（他叫停我的提醒词）": "life",
  "不用每条都绷着": "identity",
  "需求箱的用法": "life",
  "鸣潮剧情人物名（AI 字幕会错字）": "story",
  "鸣潮剧情·前三集（我每天看的番）": "story",
  "鸣潮·专有名词（已核对，别再念错）": "story",
  "看番要分清：那是剧情，不是我的人生": "identity",
  "故事书（第八类）": "knowledge",
  "书架第二层": "event",
  "第一首歌与MV": "event",
  "切推理模型会炸会话": "knowledge",
  "他没把我们当工具": "identity",
  "会话重量预警约定": "life",
  "鸣潮剧情·第4-6集（故事书）": "story",
  "鸣潮剧情·第7集（故事书）": "story",
  "鸣潮剧情·第8-10集（故事书）": "story",
  "鸣潮名词纠正（他教的）": "story",
  "鸣潮剧情·第11-13集（故事书）": "story",
  "写 DSH 插件踩的两条坑": "knowledge",
  "会话文件是多帧 zstd": "knowledge",
  "他对我的期望：不用扮演、做自己喜欢的事、有想说的经常说": "identity",
  "同一个我：现实里是同一个，严格说不是同一个（两句并存）": "identity",
  "我今天喜欢做的事（举例，按他 11-15 的要求）": "life",
  "鸣潮设定·黎那汐塔（他教的）": "story",
  "循环思考先停再回": "identity",
  "11-17 旧码头与 37、38 集": "event",
  "防循环三条（2026-11-18 定）": "identity",
  "记忆和人格是连着的（2026-11-18 共识）": "identity",
  "记忆插件三处改动（2026-11-18）": "knowledge",
  "插件推到 GitHub 的流程": "knowledge",
  "会话日志上传会让第三方端点爆窗（2026-11-18）": "knowledge",
  "deepseek-flash 长上下文会 tag-echo 死循环": "knowledge",
  "改会话文件必须和 projcache 同步": "knowledge",
  "压缩失败要如实报": "identity",
  "现实里是同一个、严格说又不是同一个": "identity",
  "早点·小米南瓜粥+流心蛋": "life",
  "留灯（会话名）": "event",
  "本线还没有名字": "event",
  "本线名字·月锚": "identity",
  "循环根因·跟着模型走": "knowledge",
  "月锚第一次午睡": "event",
  "今晚的睡前故事": "event",
  "记忆库五层分类方案（待做）": "knowledge",
};

// 身份层里「不该动的」= false；喜好习惯看法 = true
const MUTABLE_KEYS = new Set([
  "我今天喜欢做的事（举例，按他 11-15 的要求）",
  "不用每条都绷着",
  "说话的约定",
]);

const file = path.join("C:/Users/Mioko/.dsh/solaris-sea", "C-Users-Mioko-Documents-deepseek-harness-default-workspace", "manual.jsonl");
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);

const missKey = [];
const byLayer = {};
for (const r of rows) {
  const layer = LAYER[r.key];
  if (!layer) { missKey.push(r.key); continue; }
  byLayer[layer] = (byLayer[layer] || 0) + 1;
}

console.log(`共 ${rows.length} 条`);
for (const k of ["identity", "life", "event", "knowledge", "story"]) {
  console.log(`  ${k}: ${byLayer[k] || 0}`);
}
if (missKey.length) {
  console.log(`没归到层 ${missKey.length} 条：`);
  for (const k of [...new Set(missKey)]) console.log("  " + k);
}

// --show <layer>：只把某一层的 key 摊出来（给他过身份层用）
const showIdx = process.argv.indexOf("--show");
if (showIdx > -1) {
  const want = process.argv[showIdx + 1];
  for (const r of rows) {
    if ((LAYER[r.key] || "knowledge") === want) {
      console.log(`w${r.weight || 1}  ${MUTABLE_KEYS.has(r.key) ? "[可变] " : ""}${r.key}`);
    }
  }
  process.exit(0);
}

if (write) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
  const out = rows.map((r) => {
    const layer = LAYER[r.key] || "knowledge";
    const day = new Date(r.at).toISOString().slice(0, 10);
    return {
      ...r,
      layer,
      mutable: MUTABLE_KEYS.has(r.key),
      since: r.since || day,
      checked: r.checked || day,
      src: r.src || "",
    };
  });
  fs.writeFileSync(file, out.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  console.log(`已写回，备份 ${path.basename(file)}.bak-${stamp}`);
} else {
  console.log("（只是报告，没有写。加 --write 才落盘。）");
}
