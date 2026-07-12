# RatioFix 独立回归测试

本目录中的测试直接读取根目录 `RatioFix.html`，不修改或复制业务源码，也不新增依赖。

运行：

```powershell
node --test ratiofix-tests/ratiofix.regression.test.js
```

覆盖范围：

- 自动配平结果严格满足 `Σ(点数 × 调价) = 0`
- 自动配平结果不会产生负单价
- 自动配平结果可保存为恢复快照
- 自动配平后手动调价不会在 `change`/失焦时回退
- 手动调价严格配平时允许进入下一步
- 手动调价未配平时禁止进入下一步
- 手动调价写入草稿后保持当前值

