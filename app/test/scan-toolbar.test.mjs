import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCAN_TOOLS, toolbarPreferences, moveToolbarTool } from '../renderer/scan-toolbar.mjs';

test('saved toolbar choices retain operator order and pins while dropping stale or duplicate tools',()=>{
  const source={order:['flip','missing','flip','mark'],pinned:['clear','clear','missing']};
  const result=toolbarPreferences(source);
  assert.deepEqual(result.order.slice(0,2),['flip','mark']);
  assert.equal(result.order.length,SCAN_TOOLS.length);
  assert.equal(new Set(result.order).size,SCAN_TOOLS.length);
  assert.deepEqual(result.pinned,['clear']);
  assert.deepEqual(source.order,['flip','missing','flip','mark']);
});

test('an intentionally empty toolbar still has valid settings; malformed settings use defaults',()=>{
  assert.deepEqual(toolbarPreferences({pinned:[]}).pinned,[]);
  const defaults=toolbarPreferences(null);
  assert.deepEqual(defaults.pinned,['follow','zoom','unzoom','lanes','hideEmpty']);
  assert.ok(!defaults.pinned.includes('clear')&&!defaults.pinned.includes('revert'));
  assert.deepEqual(toolbarPreferences({order:'bad',pinned:'bad'}),defaults);
});

test('reordering retains current pins and cannot move a tool outside the list',()=>{
  const source=toolbarPreferences({pinned:['flip','lanes']});
  const moved=moveToolbarTool(source,'zoom',-1);
  assert.equal(moved.order[0],'zoom');assert.deepEqual(moved.pinned,['flip','lanes']);
  assert.notDeepEqual(source.order,moved.order);
  assert.deepEqual(moveToolbarTool(moved,'zoom',-1),moved);
  assert.deepEqual(moveToolbarTool(moved,'missing',1),moved);
});
