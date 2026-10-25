// v0.4.1 回归：DSH 回合错误要能定位（错误码 + 脱敏详情），又不能把秘密发到群里。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describeAgentError, agentErrorUserText, agentErrorCode, isConfigError } from '../src/lib/agent-errors.mjs';

const winPath = ['C:', 'Users', 'someone', 'secret.txt'].join(path.win32.sep);

test('缺凭据：识别错误码与类别，日志可读，不再被整条隐藏', () => {
  const d = describeAgentError({ message: `llm-deepseek: no API key for provider route "deepseek-official" (${winPath}) code "MISSING_CREDENTIAL" token=abcdef123456` });
  assert.equal(d.code, 'MISSING_CREDENTIAL');
  assert.equal(d.kind, 'credential');
  assert.ok(isConfigError(d));
  assert.match(d.logText, /MISSING_CREDENTIAL/);
  assert.match(d.logText, /no API key/, '保留能定位问题的文字');
  assert.ok(!d.logText.includes('abcdef123456'), '凭据值被抹掉');
  assert.ok(!d.logText.includes('someone'), '本机路径被抹掉');
  assert.match(d.hint, /API Key/);
});

test('群聊里只给错误码和通俗说明，不带原文；owner 私聊带提示与详情', () => {
  const d = describeAgentError({ code: 'MISSING_CREDENTIAL', message: 'no api key; password=hunter2' });
  const group = agentErrorUserText(d, { audited: true });
  assert.match(group, /错误码 MISSING_CREDENTIAL/);
  assert.ok(!group.includes('no api key'));
  assert.ok(!group.includes('hunter2'));
  const owner = agentErrorUserText(d, { audited: false });
  assert.match(owner, /DSH 设置/);
  assert.ok(!owner.includes('hunter2'));
});

test('已知会话令牌精确抹掉；各类错误分类', () => {
  const tok = 'a'.repeat(32);
  assert.ok(!describeAgentError({ message: `bad token ${tok}` }, { secrets: [tok] }).detail.includes(tok));
  assert.equal(describeAgentError({ message: 'HTTP 402 Insufficient Balance' }).kind, 'quota');
  assert.equal(describeAgentError({ message: '429 Too Many Requests' }).kind, 'rate');
  assert.equal(describeAgentError({ message: 'fetch failed ECONNREFUSED' }).kind, 'network');
  assert.equal(describeAgentError({ message: 'something odd' }).kind, 'other');
  assert.equal(agentErrorCode({ code: 503 }), 'HTTP_503');
  assert.equal(agentErrorCode(undefined), 'UNKNOWN');
});
