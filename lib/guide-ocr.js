/* 指南页的本地模拟演示：所有成员、评论与截图均为虚构，排表由现有规则计算。 */
(function () {
  'use strict';
  var P = window.CommentParse;
  if (!P) return;
  var roleNames = Array.from('甲乙丙丁戊己庚辛', function (c) { return '角色' + c; });
  var images = [
    { id: 'one', name: '1.png', comments: [['成员01','角色甲2 角色乙1 角色丙1'],['成员02','角色丁1 角色戊2'],['成员03','角色己1 角色庚1'],['成员04','角色辛2 角色乙1']] },
    { id: 'two', name: '2.png', comments: [['成员09','角色甲凹 角色乙1 角色丙1'],['成员10','角色丁1 角色戊1 角色己1'],['成员11','角色庚1 角色辛1'],['成员12','角色甲1 角色乙1']] },
    { id: 'three', name: '3.png', comments: [['成员05','甲1 丙2'],['成员06','角色丁2 角色己1'],['成员07','角色戊1 角色庚2'],['成员08','角色辛1 角色乙1']] }
  ];
  var ordered = [images[0], images[2], images[1]];
  var aliases = Object.fromEntries(roleNames.map(function (r) { return [r,r]; }));
  aliases.甲 = '角色甲'; aliases.丙 = '角色丙';
  var prices = Object.fromEntries(roleNames.map(function (r) { return [r,10]; }));
  var records = ordered.flatMap(function (im) { return im.comments.map(function (c,i) { return { cn:c[0], body:[c[1]], sourceId:im.id, index:i }; }); });

  function result(mode) {
    var rows = records.map(function (r) { return { cn:r.cn, body:[mode === 'single' && r.cn === '成员09' ? r.body[0].replace('角色甲凹','角色甲2') : r.body[0]] }; });
    var settled = P.settle(rows,{ aliasMap:aliases, orderMode:mode, totalQuota:mode === 'ratio' ? 4 : null });
    var sheet = P.buildSheet(settled,roleNames);
    var matrix = P.toSheetMatrix(sheet,'演示品类',prices,{removeGray:mode === 'ratio'});
    var people = new Map();
    matrix.slice(3).forEach(function (row) { row.slice(1).forEach(function (name) {
      if (!name) return;
      var old = people.get(name) || {cn:name,points:0,money:0};
      old.points++; old.money += 10; people.set(name,old);
    }); });
    var persons = Array.from(people.values());
    return {sheet:sheet, settled:settled, matrix:matrix, persons:persons,
      points:persons.reduce(function (n,p) { return n+p.points; },0),
      money:persons.reduce(function (n,p) { return n+p.money; },0)};
  }
  var outcomes = {single:result('single'),ratio:result('ratio')};
  function safe(s) { return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function imageRows(im,full) {
    return im.comments.map(function (c,i) { return '<div class="oc-comment"><span class="oc-avatar" aria-hidden="true">' + (i+1) + '</span><span class="oc-comment-text"><b>' + safe(c[0]) + '</b><span>' + safe(c[1]) + '</span><small>2026-09-30　回复</small></span></div>'; }).join('');
  }
  function imageCard(im,i,drag) {
    return '<div class="oc-card' + (drag && im.id === 'two' ? ' drag' : '') + '" data-image="' + im.id + '"><div class="oc-image">' + imageRows(im,false) + '</div><div class="oc-card-label"><b>' + (i+1) + '. ' + im.name + '</b><span class="oc-grip">拖动排序</span></div></div>';
  }
  function queueView(kind,progress) {
    var list = kind === 'sorted' ? ordered : images;
    var status = kind === 'recognized' ? '按顺序识别　' + progress + '/3 张' : kind === 'sorted' ? '图片顺序　1 → 3 → 2　已确认' : '三张分图　等待确认顺序';
    return '<div class="oc-queue">' + list.map(function(im,i){return imageCard(im,i,kind === 'drag');}).join('') + '</div><div class="oc-state-line">' + status + '</div>' + (kind === 'recognized' ? '<div class="oc-progress"><i style="width:' + (progress/3*100) + '%"></i></div>' : '');
  }
  function aliasView(done) {
    return '<div class="oc-cardlet"><div class="oc-cardlet-title">角色对照 · ' + (done?'八个规范角色':'称呼待确认') + '</div><div class="oc-alias-row"><span>甲</span><span>→</span><strong>' + (done?'角色甲':'待填归属') + '</strong></div><div class="oc-alias-row"><span>丙</span><span>→</span><strong>' + (done?'角色丙':'待填归属') + '</strong></div><div class="oc-role-list">' + roleNames.map(function(r){return '<span>'+r+'</span>';}).join('') + '</div><div class="oc-state-line">12 条评论 · ' + (done?'角色对照已确认':'先核对同角色的不同称呼') + '</div></div>';
  }
  function originalView(step) {
    var im=images[1];
    return '<div class="oc-review"><div class="oc-review-label">成员09　角色甲凹 角色乙1 角色丙1</div><div class="oc-origin"><strong>校对区原图 · ' + im.name + '</strong><div class="oc-fake-photo">' + imageRows(im,true) + '</div></div>' + (step>0?'<div class="oc-float-image' + (step>1?' zoom':'') + (step>2?' moved resized':'') + '"><header><strong>' + im.name + '</strong><span>−　' + (step>1?'125':'100') + '%　+　×</span></header><div class="oc-float-body"><div class="oc-fake-photo">' + imageRows(im,true) + '</div></div><footer>可缩放 · 拖动标题移动 · 右下角调整大小</footer></div>':'') + '</div>';
  }
  function miniSheet(r,mode,limit) {
    var rows = r.sheet.cells;
    return '<div class="oc-sheet-scroll"><table class="oc-sheet"><thead><tr><th>演示品类</th>' + roleNames.map(function(){return '<th></th>';}).join('') + '</tr><tr><th>种类</th>' + roleNames.map(function(role){return '<th>'+role+'</th>';}).join('') + '</tr><tr><th>序号/单价</th>' + roleNames.map(function(){return '<th>10</th>';}).join('') + '</tr></thead><tbody>' + rows.map(function(row,i){return '<tr' + (mode==='ratio' && i>=4?' class="gray"':'') + '><th>'+(i+1)+'</th>'+row.map(function(c){return '<td>'+safe(c||'')+'</td>';}).join('')+'</tr>';}).join('') + '</tbody></table></div>' + (limit?'<div class="oc-state-line">底部灰行不计入有效配数</div>':'');
  }
  function modeView(mode,edited) {
    var r=outcomes[mode];
    return '<div class="oc-cardlet oc-mode-card"><div class="oc-mode-line"><span class="oc-pill chosen">'+(mode==='single'?'单领模式':'配比模式')+'</span>'+(mode==='ratio'?'<span class="oc-pill">总配数 4 / 角色</span>':'<span class="oc-pill">不填总配数</span>')+'</div>'+
      (mode==='single'?'<div class="oc-comment-edit"><span>成员09</span><del>角色甲凹</del><span class="oc-arrow">→</span><b>'+ (edited?'角色甲2':'请填写明确数量')+'</b></div>':'<div class="oc-comment-edit"><span>成员09</span><b>角色甲凹 → 补 1 个</b></div><div class="oc-caution">成员12的角色甲1在凹之后，不再排入</div>')+
      (mode==='ratio'?'<div class="oc-caution">角色乙第 5 个超额，底部第 5 行整行置灰</div>':'')+
      '<div class="oc-role-list">'+roleNames.map(function(role){return '<span>'+role+' '+r.sheet.totals[role]+'</span>';}).join('')+'</div></div>';
  }
  function liveView(mode,zoomed) {
    var r=outcomes[mode];
    return '<div class="oc-live-context"><span>品类名　演示品类</span><span>角色单价　10元</span><span>文件名　'+(mode==='single'?'单领演示':'配比演示')+'</span></div><div class="oc-live'+(zoomed?' zoomed':'')+'"><header>实时排表 <span>'+roleNames.length+' 角色 · '+r.points+' 有效点</span><b>□　×</b></header>'+miniSheet(r,mode,mode==='ratio')+'<footer>可移动 · 可调整大小</footer></div>';
  }
  function exportView(mode,step) {
    var r=outcomes[mode], file=mode==='single'?'单领演示.xlsx':'配比演示.xlsx';
    return '<div class="oc-export"><div class="oc-export-title">确认校对　→　导出排表</div>'+miniSheet(r,mode,mode==='ratio')+
      (mode==='ratio' && step===0?'<div class="oc-choice"><b>处理超出配数</b><span>删除灰行并继续</span><span>保留灰行</span><span>取消</span></div>':'<div class="oc-success">模拟导出：'+file+' · '+r.points+' 点</div>')+'</div>';
  }
  function handoffView(mode,step) {
    var r=outcomes[mode];
    return '<div class="oc-cardlet"><div class="oc-cardlet-title">转入肾表</div><div class="oc-state-line">演示品类　·　'+r.points+' 有效点　·　'+r.persons.length+' 位成员</div>' +
      (mode==='ratio'&&step===0?'<div class="oc-choice inline"><b>再次确认灰行</b><span>删除灰行并继续</span><span>保留灰行</span><span>取消</span></div>':'<div class="oc-transfer">接收排表.xlsx　→　分类式　→　开始处理</div>')+'</div>';
  }
  function kidneyView(mode,complete) {
    var r=outcomes[mode];
    return '<div class="oc-cardlet oc-kidney"><div class="oc-cardlet-title">肾表 · 分类式　'+(complete?'导出完成':'结果预览')+'</div><div class="oc-kidney-head"><span>昵称</span><span>点数</span><span>肾额</span></div>'+
      r.persons.slice(0,5).map(function(person){return '<div class="oc-kidney-row"><span>'+person.cn+'</span><span>'+person.points+'</span><span>¥'+person.money+'</span></div>';}).join('')+
      '<div class="oc-kidney-total"><span>共 '+r.persons.length+' 位成员</span><b>'+r.points+' 点</b><b>¥'+r.money+'</b></div>'+
      (complete?'<div class="oc-success">模拟导出肾表完成</div>':'<div class="oc-state-line">按昵称汇总；其余成员在完整表内查看</div>')+'</div>';
  }
  var labels={queue:'导入分图',drag:'拖动换序',sorted:'确认顺序',recognized:'本地批量识别',alias:'角色对照',original:'原图校对',mode:'模式与数量',live:'实时排表',export:'导出排表',handoff:'转肾表',kidney:'肾表计算',done:'导出肾表'};
  var notes={queue:'三张模拟分图 · 每张四条评论',drag:'把第二张拖到第三张后面',sorted:'确认顺序：1 → 3 → 2',recognized:'一次识别整批，日期不参与排序',alias:'简称甲、丙归入对应角色',original:'仅校对区原图可打开悬浮窗',mode:'八个角色按当前模式排位',live:'八列标准排表，预览和导出保持一致',export:'先确认校对，再导出排表',handoff:'同一排表转入肾表',kidney:'按昵称统计点数与金额',done:'本次链路完成，稍后自动重播'};
  function draw(panel,mode,phase,step) {
    var html=''; step=step||0;
    if(phase==='queue'||phase==='drag'||phase==='sorted')html=queueView(phase);
    else if(phase==='recognized')html=queueView('recognized',step+1);
    else if(phase==='alias')html=aliasView(step>0);
    else if(phase==='original')html=originalView(step);
    else if(phase==='mode')html=modeView(mode,step>0);
    else if(phase==='live')html=liveView(mode,step>0);
    else if(phase==='export')html=exportView(mode,step);
    else if(phase==='handoff')html=handoffView(mode,step);
    else if(phase==='kidney'||phase==='done')html=kidneyView(mode,phase==='done'||step>0);
    var stage=panel.querySelector('.oc-screen');
    stage.dataset.phase=phase;
    stage.innerHTML='<div class="oc-scene-head"><strong>'+labels[phase]+'</strong><span>模拟演示 · 不读取文件</span></div><div class="oc-scene-content">'+html+'</div><div class="oc-scene-note">'+notes[phase]+'</div>';
  }
  function stepsFor(mode,helpers) {
    var tempo=0.26;
    var timings=mode==='single'?
      [[0,'queue',0],[6000,'drag',0],[9500,'sorted',0],[12000,'recognized',0],[14000,'recognized',1],[16000,'recognized',2],[18000,'alias',0],[21000,'alias',1],[25000,'original',0],[28000,'original',1],[30000,'original',2],[31000,'original',3],[33000,'mode',0],[37000,'mode',1],[40000,'live',0],[44000,'live',1],[47000,'export',0],[51000,'export',1],[54000,'handoff',1],[58000,'kidney',0],[61000,'kidney',1],[64000,'done',0]]:
      [[0,'queue',0],[6000,'drag',0],[9500,'sorted',0],[12000,'recognized',0],[14000,'recognized',1],[16000,'recognized',2],[18000,'alias',0],[21000,'alias',1],[25000,'original',0],[28000,'original',1],[30000,'original',2],[31000,'original',3],[33000,'mode',0],[37000,'mode',1],[41000,'live',0],[45000,'live',1],[49000,'export',0],[54000,'export',1],[57000,'handoff',0],[61000,'handoff',1],[64000,'kidney',0],[70000,'kidney',1],[73000,'done',0]];
    return timings.map(function(t){return [Math.round(t[0]*tempo),function(panel){
      draw(panel,mode,t[1],t[2]);
      var targets={queue:'.oc-card[data-image="one"]',drag:'.oc-card[data-image="two"] .oc-grip',sorted:'.oc-card[data-image="two"]',recognized:'.oc-progress',alias:'.oc-alias-row',original:t[2]===0?'.oc-origin':'.oc-float-image header',mode:'.oc-comment-edit',live:'.oc-live header',export:mode==='ratio'&&t[2]===0?'.oc-choice span':'.oc-export-title',handoff:'.oc-transfer',kidney:'.oc-kidney-total',done:'.oc-success'};
      var target=targets[t[1]];
      if(t[1]==='handoff'&&mode==='ratio'&&t[2]===0)target='.oc-choice span';
      if(target&&panel.querySelector(target)){
        helpers.cursorTo(panel,target);
        var cur=panel.querySelector('.m-cursor');
        if(cur)cur.classList.remove('click');
        if(['sorted','alias','original','mode','export','handoff','done'].indexOf(t[1])>=0)helpers.clickOn(panel,target);
      }
    }];});
  }
  function createScene(helpers){
    var scene={mode:'single',dur:17160,hold:1600,steps:stepsFor('single',helpers),reset:function(panel){draw(panel,scene.mode,'queue',0);}};
    scene.setMode=function(mode){scene.mode=mode;scene.dur=mode==='ratio'?19240:17160;scene.steps=stepsFor(mode,helpers);};
    return scene;
  }
  window.GuideOcr={createScene:createScene,results:outcomes,roles:roleNames,images:images};
})();
