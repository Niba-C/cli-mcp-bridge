/** 通用真实调用入口保持关闭；具体验收脚本须各自显式 opt-in。 */
process.stderr.write(
  "拒绝执行：真实模型调用默认关闭。\n" +
  "普通测试请运行 npm test。确需真实验收时，先阅读 docs/TESTING.md，\n" +
  "再选择 test:oc03-live 或 test:oc09-live，并明确配置本人的账号、模型和调用预算。\n",
);
process.exit(3);
