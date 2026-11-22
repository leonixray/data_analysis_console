# 发布检查清单：推上 GitHub 之前

## 已做完（本目录内）

- [x] 源码脱敏审计：FRED/BEA key 只在数据库里（`server_secrets` 表），源码中无字面量、无邮箱、无姓名、无账号、无真实持仓股数/成本
- [x] 自选股抽到 `server/src/watchlist.ts`（示例 9 只，改一处即可），原“持仓”标注已清除
- [x] 密钥改为“数据库优先、环境变量兜底”（`loadFredApiKey` / `loadBeaApiKey`），附 `.env.example`
- [x] `config/holdings.example.json`（示例数字，与任何人无关）+ `.gitignore`（屏蔽 `.env`、`config/holdings.json`、`*.db`）
- [x] `README.md`（中文）、`LICENSE`（MIT）
- [x] 缺 key 优雅降级已验证是现有行为（FRED 按系列报“密钥未配置”、BEA 报错被 `Promise.allSettled` 接住，其余模块照常刷新）
- [x] 独立运行已实现：`standalone/`（Bun 服务端 + 客户端构建 + Dockerfile + docker-compose.yml），不依赖 Muse 运行时；`README.md` 有本地 / Docker 运行说明。Docker 镜像未在本机实际构建验证（本机无 Docker），见 `Dockerfile` 注释。

## 还需要你做的事

1. **确认许可证**：默认 MIT（`LICENSE` 已放好）。如果你想换别的许可（比如 Apache-2.0、GPL），说一声再改。
2. **在 GitHub 上建仓库**（网页或 `gh` 都行）：
   - 建议仓库名：`data-analysis-console`
   - 可见性：Public（这就是本次开源的目的）
   - 建库时**不要**勾选“Add a README / .gitignore / license”（本目录里都有了，避免冲突）
3. **推送**（在本目录执行）：
   ```bash
   git init
   git add -A
   git status          # 先看一遍，确认没有 .env、*.db、config/holdings.json 被加进去
   git commit -m "Initial public release: data analysis console (sanitized)"
   git branch -M main
   git remote add origin git@github.com:<你的用户名>/data-analysis-console.git
   git push -u origin main
   ```
4. **推完后检查**：在 GitHub 网页上搜一下仓库里有没有你的邮箱、真实持仓数字（应当搜不到）；确认 `Settings → About` 里没有泄露信息。
5. **（可选）写一句仓库简介**：例如“中债/美股/A股/黄金/宏观数据分析管控台（Muse Space），历史对照 + 规则化信号”。

## 目前要注意的事

- **内部构建文档已移除**：原始 `docs/DATA-PLAN.md` 是内部施工日志，里面有“用户持仓”“用户决定”这类与原作者个人相关的记录，已从公开仓库删掉，不再同步。代码注释里个别 “DATA-PLAN vXX” 只是版本号引用，不含个人信息。
- **运行时依赖**：代码是 Muse TypeScript Space，服务端依赖 `@hatch/space-sdk`（Muse 运行时提供，不在 npm 上）。别人拿到仓库后最直接的用法是导入自己的 Muse；想脱离 Muse 独立跑，用 `standalone/`（已实现：Bun 服务端 + 客户端构建 + Dockerfile + docker-compose.yml，见 README“方式二 / 方式三”）。
- **快照版本**：本副本是 2026-11-23 的快照（v124，新增 AI硬件现货模块：DRAM/NAND 现货、NVDA 显卡街价、HBM 参考价位、TrendForce 现货新闻）。线上管控台后续再有改动，公开仓库需要定期同步（重新脱敏复制或 `git pull` 式同步）。
