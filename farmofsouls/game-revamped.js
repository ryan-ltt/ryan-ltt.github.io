/* Farm of Souls REVAMPED — based on the faithful HTML/JS port of Siveran's Flash game (v0.1.7).
   This copy is for bug fixes and gameplay changes; game.js stays the faithful original.
   Ported 1:1 from the decompiled AS3 (Main.as, Earth.as, Man.as, Land.as, Stash.as,
   Building.as, FoSControls.as, InfoPane.as, AchievementPane.as, ClassTree.as, ...).
   Coordinate model matches the original exactly: a 250x150 logical scene scaled x3
   at offset (25,25) onto an 800x500 stage, 30fps. Earth at logical (125,70); land
   tiles 20px wide; workers rest at earth-local y=25 (sprites 10x20, feet at 45). */

'use strict';

//////////////////// stage / transforms ////////////////////
const STAGE_W = 800, STAGE_H = 500;
const SC = 3, OX = 25, OY = 25;          // Main.scaleX/Y=3, Main.x/y=25
const FPS = 30, FRAME_MS = 1000 / FPS;
const EARTH_X = 125, EARTH_Y = 70;       // Earth.x/y

// logical -> canvas px
const LX = l => OX + SC * l;
const LY = l => OY + SC * l;
// controls-local -> logical (controls pans with camera; earth.x cancels it: +125/+70)
const CLX = c => 125 + c;
const CLY = c => 70 + c;
// earth-space -> logical
const EX = w => 125 - E.camX + w;
const EY = w => 70 + w;

//////////////////// assets ////////////////////
const IMG = {};
let assetsReady = false, fontReady = false;
const RES_SPRITE = [null,'Dirt','Wood','Clay','Stone','Iron','Silver','Gold'];
const BUILD_CAT = ['Rec','Enr','Rel','Ref','Edu','Hou','Sup','Sta'];
const CLASS_SPRITE = ['Basic','Scavenger','Farmer','Logger','Miner','Prospector','Smith',
  'Servant','Investor','Royal','Peasant','Worker','Engineer','Scholar','Mage','Wizard'];

function loadAssets(done){
  const names = ['FoSControls_BackImage','FoSControls_PersonImage','Land_SpriteImage',
    'FlyingSoul_SpriteImage','Background_Image1','Background_Image2','Background_Image3',
    'Background_Image4','Statbar_SpriteImage','Statbar_Life','Statbar_Experience',
    'GoButton_State1','GoButton_State2','AchievementPane_SpriteImage','ClassTree_SpriteImage',
    'InfoPane_SpriteImage','InfoPane_RelImage','InfoPane_EnrImage','InfoPane_EduImage',
    'InfoPane_RefImage','InfoPane_HouImage','InfoPane_SupImage','Man_TransitionImage'];
  for(let t=1;t<=7;t++) names.push('Resource_'+RES_SPRITE[t]+'Image');
  for(const cat of BUILD_CAT) for(let t=1;t<=4;t++) names.push(`Building_${cat}${t}`);
  for(const g of ['Male','Female']) for(const c of CLASS_SPRITE) names.push(`Man_${g}${c}`);
  let pending = names.length + 1;
  const dec = ()=>{ if(--pending<=0){ assetsReady=true; done(); } };
  names.forEach(n=>{
    const im = new Image();
    im.onload = dec; im.onerror = dec;
    im.src = 'art/'+n+'.png'; IMG[n] = im;
  });
  const face = new FontFace('pixelmix','url(pixelmix.ttf)');
  face.load().then(f=>{
    document.fonts.add(f);
    fontReady = true;
    for(const k in FONT_ASC) delete FONT_ASC[k];   // drop metrics measured on the fallback font
    dec();
  }).catch(dec);
}

//////////////////// text (PixelText equivalent) ////////////////////
// PixelText: pixelmix size 6 (x3 = 18 canvas px), TextField gutter 2px, default
// color 0x3D3D3D. Anchor per autoSize: left -> left edge at x+2; center -> center
// at x+2; right -> right edge at x+2. y: text top at y+2. maxW: scale down to fit.
const FONT_ASC = { }; // ascent cache per size
function fontAscent(size){
  if(!FONT_ASC[size]){
    ctx.font = (size*SC)+'px pixelmix, monospace';
    const m = ctx.measureText('0');
    FONT_ASC[size] = m.actualBoundingBoxAscent || size*SC*0.8;
  }
  return FONT_ASC[size];
}
function textW(t, size){
  ctx.font = (size*SC)+'px pixelmix, monospace';
  return ctx.measureText(t).width;
}
// x,y in CANVAS px (already transformed); size in logical font pt.
// Anchor offsets calibrated pixel-exact against the original running in Ruffle.
function drawText(t, x, y, size, color, align, maxW){
  if(t==null) return;
  t = ''+t;
  size = size||6;
  const lines = t.split('\n');
  ctx.font = (size*SC)+'px pixelmix, monospace';
  ctx.fillStyle = color || '#3d3d3d';
  const asc = fontAscent(size), lh = (size+2)*SC;
  const hOff = 2*SC - 2, vOff = size>=12 ? 6 : 8;
  let w = 0;
  for(const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
  let scale = 1;
  if(maxW && w > maxW*SC) scale = maxW*SC/w;
  for(let i=0;i<lines.length;i++){
    const ln = lines[i], lw = ctx.measureText(ln).width*scale;
    let px = x + hOff;
    if(align==='center') px -= lw/2;
    else if(align==='right') px -= lw;
    const py = y + vOff + asc + i*lh;
    if(scale!==1){ ctx.save(); ctx.translate(px,py); ctx.scale(scale,scale);
      ctx.fillText(ln,0,0); ctx.restore(); }
    else ctx.fillText(ln, Math.round(px), Math.round(py));
  }
}
// helpers in controls-local coords
function ctext(t,cx,cy,size,color,align,maxW){ drawText(t, LX(CLX(cx)), LY(CLY(cy)), size, color, align, maxW); }

//////////////////// class specs (Man.becomeClass) ////////////////////
const CLASS_SPEC = {
  1:  { minLv:2,  mult:1, likes:[1,1,1,1,1,1,1], up:false },
  2:  { minLv:6,  mult:2, likes:[1,1,0,0,0,0,0], up:false },
  3:  { minLv:10, mult:4, likes:[0,1,0,0,0,0,0], up:false },
  4:  { minLv:4,  mult:1, likes:[0,0,1,1,1,1,1], up:true  },
  5:  { minLv:8,  mult:2, likes:[0,0,0,1,1,0,0], up:false },
  6:  { minLv:12, mult:3, likes:[0,0,0,0,1,0,0], up:false },
  7:  { minLv:4,  mult:1, likes:[0,0,0,0,1,1,1], up:false },
  8:  { minLv:7,  mult:1, likes:[0,0,0,0,1,1,1], up:true  },
  9:  { minLv:14, mult:3, likes:[0,0,0,0,0,0,1], up:false },
  10: { minLv:3,  mult:2, likes:[1,1,1,0,0,0,0], up:false },
  11: { minLv:7,  mult:2, likes:[1,1,1,1,1,0,0], up:false },
  12: { minLv:11, mult:2, likes:[1,1,1,1,1,1,1], up:false },
  13: { minLv:5,  mult:1, likes:[0,1,1,1,1,1,1], up:false },
  14: { minLv:10, mult:1, likes:[1,1,1,1,1,1,1], up:true  },
  15: { minLv:15, mult:2, likes:[1,1,1,1,1,1,1], up:true  },
};

//////////////////// building data ////////////////////
// stash build costs, exactly the vectors passed to Stash.make() in the AS3
const BUILD_COST = {
  0:[10,3,0,1,5,0,0],   1:[10,3,0,1,20,0,0],   2:[0,1,0,0,60,0,0],    3:[0,0,5,25,100,5,1],
  4:[3,0,0,5,0,0,0],    5:[0,1,0,15,3,0,0],    6:[0,20,0,40,5,0,0],   7:[20,40,0,100,10,1,1],
  8:[0,0,0,0,0,2,3],    9:[0,10,0,1,3,5,10],   10:[0,20,0,3,5,10,20], 11:[1,40,3,5,10,20,40],
  12:[0,3,5,0,0,3,0],   13:[0,5,0,0,0,10,0],   14:[0,20,10,0,3,15,3], 15:[10,5,0,1,50,100,5],
  16:[0,5,0,2,0,0,0],   17:[0,50,10,5,1,0,0],  18:[0,150,25,10,2,0,0],19:[0,300,50,15,3,1,1],
  20:[5,10,15,5,0,0,0], 21:[5,10,50,15,3,0,0], 22:[10,20,100,30,5,1,0],23:[10,10,300,10,5,1,1],
  24:[25,5,0,0,0,0,0],  25:[100,10,0,1,0,0,0], 26:[250,50,0,3,1,0,0], 27:[500,10,0,0,0,5,5],
};
// per-type image anchor offsets from Building.as (image.x, image.y), building at land (10,45)
const BUILD_OFF = {
  0:[-5,-10], 1:[-10,-10], 2:[-10,-20], 3:[-10,-40],
  4:[-5,-2],  5:[-10,-2],  6:[-10,-12], 7:[-10,-40],
  8:[-5,-10], 9:[-5,-20],  10:[-10,-20],11:[-10,-40],
  12:[-5,-10],13:[-5,-20], 14:[-10,-20],15:[-10,-40],
  16:[-5,-10],17:[-10,-10],18:[-10,-20],19:[-10,-40],
  20:[-5,-10],21:[-10,-10],22:[-10,-20],23:[-10,-40],
  24:[-5,-11],25:[-5,-20], 26:[-10,-20],27:[-10,-40],
  28:[-5,-10],29:[-5,-10], 30:[-5,-20], 31:[-10,-20],
};
function buildingSprite(type){ return `Building_${BUILD_CAT[Math.floor(type/4)]}${type%4+1}`; }

//////////////////// tooltip strings ////////////////////
const RES_TIP = [null,
  'Dirt. Used for supply buildings.',
  'Wood. Used for educational buildings.',
  'Clay. Used for housing.',
  'Stone. Used for land-enriching buildings.',
  'Iron. Used for recreational buildings.',
  'Silver. Used for refinement buildings.',
  'Gold. Used for religious buildings.'];
const BUILD_TIP0 = [
  'Recreation 1/Garden: People stop here to take a long break. +1 xp/5 seconds',
  'Recreation 2/Park: People stop here to take a medium break. +1 xp/3 seconds',
  'Recreation 3/Zoo: People stop here to take a short break. +1 xp/2 seconds',
  'Recreation 4/Theatre: People stop here to take a very short break. +1 xp/second',
  'Enrichment 1/Ditch: Slightly increases resource spawn rate.',
  'Enrichment 2/Canal: Increases resource spawn rate.',
  'Enrichment 3/Mill: Greatly increases resource spawn rate.',
  'Enrichment 4/Mine: Hugely increases resource spawn rate.',
  'Religion 1/Statue: +1 soul per 100 levels.',
  'Religion 2/Church: +2 souls per 100 levels.',
  'Religion 3/Temple: +3 souls per 100 levels.',
  'Religion 4/Cathedral: +5 souls per 100 levels.',
  'Refinement 1/Well: Makes resources worth 1% more.',
  'Refinement 2/Outhouse: Makes resources worth 2% more.',
  'Refinement 3/Store: Makes resources worth 3% more.',
  'Refinement 4/Skyscraper: Makes resources worth 5% more.',
  'Education 1/Stone Tablet: Causes people to class-up slightly more often.',
  'Education 2/Library: Causes people to class-up a little more often.',
  'Education 3/School: Causes people to class-up more often.',
  'Education 4/University: Causes people to class-up a lot more often. ',
  'Housing 1/Cottage: Spawns 1 person every in-game day.',
  'Housing 2/House: Spawns 2 people a day.',
  'Housing 3/Large House: Spawns 3 people a day.',
  'Housing 4/Apartment: Spawns 5 people a day.',
  'Supply 1/Crops: Raises population limit by 5.',
  'Supply 2/Orchard: Raises population limit by 10.',
  'Supply 3/Farm: Raises population limit by 15.',
  'Supply 4/Life Tree: Raises population limit by 25.',
  'Stash 1/Stash: Builds simple things.',
  'Stash 2/Crate: Builds basic buildings.',
  'Stash 3/Storage: Builds most buildings.',
  'Stash 4/Warehouse: Builds everything.'];
const BUILD_TIP1 = [
  '10 dirt, 3 wood, 1 clay, 5 iron.',
  '10 dirt, 3 wood, 1 clay, 20 iron.',
  '1 wood, 60 iron.',
  '5 clay, 25 stone, 100 iron, 5 silver, 1 gold.',
  '3 dirt, 5 stone.',
  '1 wood, 15 stone, 3 iron.',
  '20 wood, 40 stone, 5 iron.',
  '20 dirt, 40 wood, 100 stone, 10 iron, 1 silver, 1 gold.',
  '2 silver, 3 gold.',
  '10 wood, 1 stone, 3 iron, 5 silver, 10 gold.',
  '20 dirt, 3 stone, 5 iron, 10 silver, 20 gold.',
  '1 dirt, 40 wood, 3 clay, 5 stone, 10 iron, 20 silver, 40 gold.',
  '3 wood, 5 clay, 3 silver.',
  '5 wood, 10 silver.',
  '20 wood, 10 clay, 3 iron, 15 silver, 3 gold.',
  '10 dirt, 5 wood, 1 stone, 50 iron, 100 silver, 5 gold.',
  '5 wood, 2 stone.',
  '50 wood, 10 clay, 5 stone, 1 iron.',
  '150 wood, 25 clay, 10 stone, 2 iron.',
  '300 wood, 50 clay, 15 stone, 3 iron, 1 silver, 1 gold.',
  '5 dirt, 10 wood, 15 clay, 5 stone.',
  '5 dirt, 10 wood, 50 clay, 15 stone, 3 iron.',
  '10 dirt, 20 wood, 100 clay, 30 stone, 5 iron, 1 silver.',
  '10 dirt, 10 wood, 300 clay, 10 stone, 5 iron, 1 silver, 1 gold.',
  '25 dirt, 5 wood.',
  '100 dirt, 10 wood, 1 stone.',
  '250 dirt, 50 wood, 3 stone, 1 iron.',
  '500 dirt, 10 wood, 5 silver, 5 gold.',
  '1 of each.','2 of each.','3 of each.','5 of each.'];
const BUILD_TIP2 = [
  'The manifestation of the idiom "Stop to smell the roses."',
  'Never before has an empty field of grass been so enjoyable.',
  'Locked up animals are entertaining.',
  'This theatre features a second-long version of Hamlet:\nThe entire cast walks onto stage, half of them immediately die.',
  'Primitive and simple irrigation.',
  'Land made with souls does not come with pre-installed bodies of water.',
  'Installing a watermill somehow makes the water 50% more effective!',
  'No one ever enters the mine, but it seems to work out okay anyways.',
  'A large and famous symbol of Kongrianity.',
  'Here, Kongrians celebrate their religion by playing free games.',
  'Kongrians can pray here to speak to developers and moderators.',
  'A holy internet cafe.',
  'People throw coins in and wish for a long lif--',
  'Secretly a recycling center. Occasionally they eat a chunk of iron or two.',
  'Greater than or equal to zero customers since establishment!',
  'A silver skyscraper. Pretty.',
  'Literacy has to start somewhere.',
  'Has the bestselling book, "Taking Off Your Clothes: How to Become a Scavenger".',
  'Here people learn the basic subjects, such as peasantry.',
  'Here people learn advanced subjects, such as magic.',
  'One per day!? What goes on in there?',
  'Double the space, double the random spawning.',
  '',
  '"These people might actually be rabbits." ~firedragongt',
  '','','',
  'Has magical filling fruits.',
  'There is a 100% tithe for everyone. Kongrianity is harsh.',
  "It's not a game if there aren't crates in it.",
  '',''];
const CLASS_TIP = [
  'Basic person. 1x anything. Lv1',
  'Scavenger. 1x anything. Lv2',
  'Farmer. 2x dirt and wood. Lv6',
  'Logger. 4x wood. Lv10',
  'Miner. 1x all but wood and dirt. Resource upgraded. Lv4',
  'Prospector. 2x stone and iron. Lv8',
  'Smith. 3x iron. Lv12',
  'Servant. 1x iron, silver, gold. Lv4',
  'Investor. 1x iron, silver, gold. Resource upgraded. Lv7',
  'Royal. 3x gold. Lv14',
  'Peasant. 2x dirt, wood, clay. Lv3',
  'Worker. 2x anything but silver, gold. Lv7',
  'Engineer. 2x anything. Lv11',
  'Scholar. 1x all but dirt. Lv5',
  'Mage. 1x anything. Resource upgraded. Lv10',
  'Wizard. 2x anything. Resource upgraded. Lv15'];
const CLASSTREE_HELP = [
  'Earn achievements to unlock new classes.',
  'Click a class to enable it, click a class to disable it.',
  'People will automatically class-up into enabled classes.',
  'A person must meet the level requirement of the class to become it.',
  'Education helps increase the chance of class-ups.',
  'Most classes only pick up certain resources, but multiply their value.',
  'Some classes upgrade resources to the next rarest: ',
  'dirt -> wood -> clay -> stone -> iron -> silver -> gold',
  'Enable and disable classes to influence what people build.'];

//////////////////// achievements ////////////////////
const ACH = [ // [title, tip]; id = index+1; earned flag lives in E.a[id-1]
  ['Dirt Farmer','Gather 100 dirt. Unlocks Scavenger.'],
  ['Got Wood?','Gather 100 wood. Unlocks Farmer.'],
  ['Why Are We Gathering This, Again?','Gather 1000 dirt. Unlocks Lumberjack.'],
  ['The Clay is Alive','Gather 100 clay. Unlocks Miner.'],
  ['Gorgon','Gather 100 stone. Unlocks Prospector.'],
  ['Iron Will','Gather 1000 iron. Unlocks Blacksmith.'],
  ["It's Siveran not Silveran",'Gather 100 silver. Unlocks Servant.'],
  ['All You Touched Turned Into Gold','Gather 100 gold. Unlocks Investor.'],
  ['Ooh, Shiny','Gather 1000 combined silver and gold. Unlocks Royal.'],
  ["I Can't Eat This",'Gather one resource. Unlocks Peasant.'],
  ['No Rest For Our Souls','Harvest 100 souls. Unlocks Worker.'],
  ['Epic','Get a person to level 20. Unlocks Engineer.'],
  ['Upgraded','Have 100 combined stats. Unlocks Scholar.'],
  ['Forkbomb','Have 100 people at one time. Unlocks Apprentice.'],
  ['Grim Keeper','Store 10,000 souls at once. Unlocks Wizard.'],
  ['Why Would You Do This','Play for one in-game week. Unlocks Zoo.'],
  ["The Moon Didn't Move",'Play for one in-game month. Unlocks Theatre.'],
  ['Dirty Hands','Gather 2,500 dirt. Unlocks Mill.'],
  ['Size Enhancement','Have 100 land. Unlocks Mine.'],
  ['Soul Farmer','Harvest 10,000 souls. Unlocks Temple.'],
  ['Dying Has a Burning Sensation','10,000 souls burned on stats. Unlocks Cathedral.'],
  ['Electrum','Gather 100 combined gold and silver. Unlocks Store.'],
  ['All the Better to See You With','100 sight. Unlocks Skyscraper.'],
  ['Paper','Gather 1000 wood. Unlocks School.'],
  ['Technology','Build 100 buildings. Unlocks University.'],
  ['Phoenix','Reincarnate 1000 people. Unlocks Large House.'],
  ['Idle Game','1000 people spawned from houses. Unlocks Apartment.'],
  ['Gotta Build Em All','Build 20 buildings. Unlocks Farm.'],
  ['Limit Breaker','100 speed. Unlocks Life Tree.'],
  ["Rome Wasn't Built in a Day",'Build 10 buildings. Unlocks Storage.'],
  ['Metropolis','Build 50 buildings. Unlocks Warehouse.'],
];
// render state per achievement (Achievement.renderState): 0 unearned, 1 fresh,
// 2 seen-in-open-pane, 3 settled (green)
let achState = new Array(31).fill(0);
let splashes = [];   // AchievementSplash: {x, curAlpha, alpha, text}

function earnAchievement(i){ // i = 0-based
  if(E.a[i]) return;
  E.a[i] = true;
  achState[i] = 1;
  splashes.push({ x:125, curAlpha:2, alpha:1, text:'Achievement: '+ACH[i][0] });
}

//////////////////// game state ////////////////////
const game = { mode:'loading', load:false, slot:0, fading:0, fadePhase:0, menuHover:-1 };

let E = null;
function newEarth(){
  return {
    lvLand:13, lvSpeed:10, lvLife:10, lvSight:10,
    souls:1, people:0,
    supCap:10, supply:0,
    fertCap:0, relCap:0, refCap:0, eduCap:0, housing:0,
    fertility:0, religion:0, refinement:0, education:0,
    paused:false, buildout:true, autosave:true, showTips:true,
    hasStash:false, leftBound:0, rightBound:0,
    panic:[false,false,false,false,false,false,false,false],
    a:new Array(31).fill(false),   // achievements (Earth.a)
    c:new Array(15).fill(false),   // enabled classes (Earth.c)
    averagePop:0, recordPop:0,
    // FoSControls fields (recSouls starts 0, so the starting soul counts into totSouls)
    totSouls:0, recSouls:0, resource:0, maxLv:0, reincarn:0, playtime:0,
    spawn:0, burned:0, b:0, avgLevel:0, deaths:0,
    r:[0,0,0,0,0,0,0],             // lifetime per-type resource counts
    camX:0, camVel:0,
    goingLeft:false, goingRight:false, shift:false, ctrl:false,
    keytipcount:0, saveTimer:0, submitDelay:0,
    // InfoPane fields
    effRel:100, effEnr:100, effEdu:100, effRef:100, effHou:100, effSup:100,
  };
}
let land = [], men = [];
let hasSoul = false, dragSoul = null;          // dragSoul: {x,y} controls-local top-left
let mouseCL = {x:0,y:0};                       // last mouse pos, controls-local
let skyX = 25;                                 // FoSControls.backImage.x (stage-level, logical px)
let frameCount = 0;
let tooltip = '';                              // toolTipText content (persists)
// panes
let infoOpen=false, achOpen=false, classOpen=false, classHelp=0;
let achOffset = 0;
const sbOffsets = [0,0,0,0,0]; // info pane scrollboxes: stats, options, help, credits, misc
let muted = false, volume = 10;

function toolTip(t){ if(E && E.showTips) tooltip = t||''; }

//////////////////// Land ////////////////////
function makeLand(index){
  const L = { index, x:0, resourceCounter:30, resourceType:0, hasStash:false,
    hasBuilding:false, buildingType:0, resource:null, stash:null,
    spawnTimer:Math.floor(Math.random()*100) };
  if(Math.random()>0.5) landGainResource(L, 3);
  return L;
}
// Resource(param1): random roll; forced type wins its slot => acts as a rarity cap
function rollResource(force){
  const r = Math.random()*100;
  if(r<=35 || force===1) return 1;
  if(r<=55 || force===2) return 2;
  if(r<=75 || force===3) return 3;
  if(r<=85 || force===4) return 4;
  if(r<=93 || force===5) return 5;
  if(r<=98 || force===6) return 6;
  return 7;
}
function landGainResource(L, cap){
  const t = rollResource(cap);
  L.resource = { type:t };
  L.resourceType = t;
}
function landLoseResource(L){ L.resource=null; L.resourceType=0; }

function addLand(){
  const L = makeLand(land.length);
  if(land.length % 2 === 0) L.x = land.length*10;
  else L.x = land.length*-10 - 10;
  land.push(L);
  E.buildout = true;
  E.panic = [false,false,false,false,false,false,false,false];
  E.leftBound = Math.floor(land.length/2) * -20;
  E.rightBound = Math.ceil(land.length/2) * 20;
}
function positionToLand(px){
  if(px<0) return Math.floor(-px/20)*2 + 1;
  return Math.floor(px/20)*2;
}

// Land.onFrame
function landFrame(L){
  if(L.resourceCounter>=30 && L.hasStash){
    stashTryBuild(L);
    L.resourceCounter = Math.floor(Math.random()*5);
  } else if(L.resourceCounter>=30 && L.buildingType<=3){
    if(Math.random()*(100+E.fertCap)>95 && L.resource==null) landGainResource(L, E.maxLv+2);
    else if(Math.random() > 0.95 + L.resourceType/200) landLoseResource(L);
    L.resourceCounter = Math.floor(Math.random()*5);
  } else if(L.buildingType>=20 && L.buildingType<=23){
    const thresh = [5400,2600,1800,1080][L.buildingType-20];
    if(++L.spawnTimer > thresh){
      if(Math.random() < E.effHou/100) dropSoul(L.x+10);
      L.spawnTimer = Math.random()*50-25;
      E.spawn++;
    }
  }
  L.resourceCounter++;
}

// Land.build
function landBuild(L, type){
  if(L.hasBuilding){
    applyCap(L.buildingType, -1);
    E.b--;
  }
  L.buildingType = type;
  landLoseResource(L);
  L.hasBuilding = true;
  applyCap(type, +1);
  if(type>=24 && type<=27) updateSouls();
  if(type>=28 && type<=31 && !L.hasStash){
    L.hasStash = true;
    L.stash = { r:[0,0,0,0,0,0,0], b:[0,0,0,0,0,0,0,1] };
  }
  E.b++;
  L.tip = 0;
}
function applyCap(type, sign){
  const cat = Math.floor(type/4), tier = type%4;
  const v = [1,2,3,5][tier]*sign;
  if(cat===1) E.fertCap += v;
  else if(cat===2) E.relCap += v;
  else if(cat===3) E.refCap += v;
  else if(cat===4) E.eduCap += v;
  else if(cat===5) E.housing += v;
  else if(cat===6) E.supCap += [5,10,15,25][tier]*sign;
}

//////////////////// Stash ////////////////////
// Stash.make: b[cat] is a tier-probe counter; only tiers >= b[cat] are attempted
function stashMake(L, type, cost){
  const S = L.stash, cat = Math.floor(type/4);
  if(S.b[cat] <= type%4 &&
     S.r[0]>=cost[0] && S.r[1]>=cost[1] && S.r[2]>=cost[2] && S.r[3]>=cost[3] &&
     S.r[4]>=cost[4] && S.r[5]>=cost[5] && S.r[6]>=cost[6]){
    if(earthBuild(type, L.index)){
      for(let t=0;t<7;t++) S.r[t] -= cost[t];
      if(S.b[cat] < 3) S.b[cat]++;
      else S.b[cat] = 0;
      return true;
    }
    if(!E.buildout){
      if(S.b[cat] !== 3) S.b[cat]++;
      if(S.b[cat] > 3) S.b[cat] = 0;
    }
  }
  return false;
}
// Stash.tryBuild: rotate through 7 categories starting at a random one, trying
// tiers 1..4 (stop at first success); then the stash self-upgrade chain.
function stashTryBuild(L){
  const S = L.stash;
  let i = Math.floor(Math.random()*7);
  const end = i+7;
  while(++i <= end){
    const cat = i%7;
    for(let tier=0; tier<4; tier++){
      const type = cat*4 + tier;
      if(stashMake(L, type, BUILD_COST[type])) break;
    }
  }
  const rge = n => S.r[0]>=n&&S.r[1]>=n&&S.r[2]>=n&&S.r[3]>=n&&S.r[4]>=n&&S.r[5]>=n&&S.r[6]>=n;
  if(rge(1) && S.b[7]===1){
    for(let t=0;t<7;t++) S.r[t]-=1;
    S.b[7]=2; landBuild(L,29);
  } else if(rge(3) && S.b[7]===2 && E.a[29]){
    for(let t=0;t<7;t++) S.r[t]-=3;
    S.b[7]=3; landBuild(L,30);
  } else if(rge(5) && S.b[7]===3 && E.a[30]){
    for(let t=0;t<7;t++) S.r[t]-=5;
    S.b[7]=4; landBuild(L,31);
  }
}

//////////////////// Earth ////////////////////
// Earth.build
function earthBuild(type, nearIdx){
  const cat = Math.floor(type/4), tier = type%4;
  if(E.panic[cat] || !(E.a[15 + cat*2 + tier - 2] || tier<=1)) return false;
  let c = 0, idx = nearIdx, step = 2;
  if(E.buildout){
    while(c<=4){
      idx += step;
      if(idx < land.length*2/3 && idx > -land.length*2/3){
        const li = idx<0 ? -idx-1 : idx;
        c = 0;
        if(!land[li].hasBuilding){ landBuild(land[li], type); c = 100; }
      } else c++;
      step = step>=0 ? -2-step : 2-step;
      if(c===100) break;
    }
    if(c===100) return true;
    E.buildout = false;
    return false;
  }
  while(c<4){
    idx += step;
    if(idx < land.length*2/3 && idx > -land.length*2/3){
      const li = idx<0 ? -idx-1 : idx;
      c = 0;
      if(land[li].hasBuilding && Math.floor(land[li].buildingType/4)===cat && land[li].buildingType%4 < tier){
        landBuild(land[li], type); c = 5;
      }
    } else c++;
    step = step>=0 ? -2-step : 2-step;
    if(c===5) break;
  }
  if(c===5) return true;
  if(tier===3) E.panic[cat] = true;
  return false;
}

// Earth.seek
function seek(M){
  let foundRes = 0, foundBuild = 0, buildIdx = 0;
  let li = positionToLand(M.x), step = 2, i = 0;
  while(i < M.sight){
    if(li < land.length && li > -land.length){
      const idx = li<0 ? -li-1 : li;
      const L = land[idx];
      if(L.resourceType!==0 && M.likes[L.resourceType-1] && L.resourceType <= M.level+2){
        foundRes = L.x + 10 - M.x;
        i = M.sight;
        if(Math.abs(foundRes) < 10){
          const res = L.resource;
          landLoseResource(L);
          pickup(M, res);
        }
      } else if(L.hasBuilding && L.buildingType<=3 && foundBuild===0){
        foundBuild = L.x + 10 - M.x;
        buildIdx = idx;
      }
    }
    i++;
    li += step;
    step = step>=0 ? -2-step : 2-step;
  }
  if(foundRes!==0 || foundBuild===0 || M.drive>0) return foundRes;
  if(Math.abs(foundBuild) < 10){
    M.recreate = true;
    M.seekDelay = 30;
    switch(land[buildIdx].buildingType){
      case 0: M.rec += 1; break;
      case 1: M.rec += 2; break;
      case 2: M.rec += 3; break;
      case 3: M.rec += 5;
    }
  }
  return foundBuild;
}

// Earth.findStash
function findStash(M){
  let dir = 0;
  let li = positionToLand(M.x), step = 2, i = 0;
  if(E.hasStash){
    while(i<=20){
      if(li < land.length && li > -land.length+1){
        const idx = li<0 ? -li-1 : li;
        const L = land[idx];
        if(L.hasStash){
          dir = L.x + 10 - M.x;
          if(Math.abs(dir) < 10){
            const bonus = Math.floor(Math.random()*E.refinement/50);
            L.stash.r[M.resource.type-1] += M.multiplier*(bonus+1);
            addResource(M.resource.type, M.multiplier*(bonus+1));
            M.resource = null;
          }
          i = 100;
          continue;
        }
      }
      i++;
      li += step;
      step = step>=0 ? -2-step : 2-step;
    }
  }
  if(i < 100){
    const p = positionToLand(M.x);
    if(p < land.length*2/3){
      landBuild(land[p], 28);
      M.exp++;
      E.hasStash = true;
    }
    else if(p%2===0) dir = -1;
    else dir = 1;
  }
  return dir;
}

// Earth.dropSoul
function dropSoul(px){
  if(E.people < E.supply){
    E.people++;
    const M = makeMan(px);
    men.push(M);
    updateSouls();
    return true;
  }
  return false;
}
// Earth.harvestSouls + FoSControls.sendHighScore
function harvestSouls(n, level){
  E.souls += n;
  updateSouls();
  if(level > E.maxLv) E.maxLv = level;
  E.avgLevel += (level - E.avgLevel) / E.deaths++;
}
// FoSControls.addResource
function addResource(type, amt){
  if(type!==0) E.r[type-1] += amt;
  E.resource += amt;
}
// FoSControls.updateSouls
function updateSouls(){
  if(E.souls > E.recSouls) E.totSouls += E.souls - E.recSouls;
  E.recSouls = E.souls;
}
// InfoPane.updateStats property recompute (the only place properties update)
function updateProperties(){
  E.religion   = Math.trunc(E.relCap  * (E.effRel/100));
  E.fertility  = Math.trunc(E.fertCap * (E.effEnr/100));
  E.education  = Math.trunc(E.eduCap  * (E.effEdu/100));
  E.refinement = Math.trunc(E.refCap  * (E.effRef/100));
  E.supply     = Math.trunc(E.supCap  * (E.effSup/100));
  updateSouls();
}

//////////////////// Man ////////////////////
function makeMan(px){
  return {
    x:px, y:0, xvel:0, yvel:0, direction:0,
    life:E.lvLife*40, maxLife:E.lvLife*40, exp:0, level:1, rec:0,
    sight:Math.floor(E.lvSight/2), speed:Math.sqrt(E.lvSpeed),
    male:Math.random()>0.5, curClass:0, multiplier:1, up:false,
    likes:[1,1,1,1,1,1,1], resource:null, drive:300, seekDelay:0, recreate:false,
    dying:false, dead:false, dieCounter:0, souls:0, soularray:[],
    facing:1,
  };
}
function manLive(M){
  M.life--; M.drive--;
  if(M.life<=0) M.dying = true;
  if(M.y < 24.9) M.yvel += 0.5;
  else if(M.y > 25.1){ M.y = 25; M.xvel = M.yvel = 0; }
  else if(Math.random()*100 < M.speed*5 && !M.recreate){
    M.yvel = -1;
    if(M.direction===0) M.xvel = Math.random()*M.speed - M.speed/2;
    else if(M.direction<0) M.xvel = Math.random()*M.speed/-2 - 1;
    else M.xvel = Math.random()*M.speed/2 + 1;
  }
  M.recreate = false;
  if(M.xvel>0.1) M.facing = 1;
  else if(M.xvel<-0.1) M.facing = -1;
  M.y += M.yvel; M.x += M.xvel;
  if(M.x < E.leftBound+5) M.x = E.leftBound+5;
  else if(M.x > E.rightBound-5) M.x = E.rightBound-5;
  if(M.seekDelay<=0 && M.y<=25.1){
    if(M.resource) M.direction = findStash(M);
    else M.direction = seek(M);
  } else {
    M.seekDelay--;
    M.direction = 0;
  }
  if(M.rec>=150){ M.exp++; M.rec = 0; M.drive = 300; }
  if(M.exp>=M.level){
    M.exp -= M.level;
    M.level++;
    classUp(M);
  }
}
function manDie(M){
  M.dieCounter++;
  if(M.dieCounter===20){
    M.souls = Math.ceil(M.level/2) + Math.floor(E.religion*M.level/100);
    M.soularray = [];
    const n = M.souls>10 ? 10 : M.souls;
    for(let i=0;i<n;i++){
      M.soularray.push({
        x0: M.x - E.camX + Math.random()*10,
        y0: M.y + Math.random()*10,
        x:0, y:0,
        xvel: Math.random()*2-1, yvel: Math.random()*2-1,
        expire:0,
      });
      const s = M.soularray[i];
      s.x = s.x0; s.y = s.y0;
    }
  } else if(M.dieCounter>20 && M.dieCounter<=40){
    for(const s of M.soularray){
      if(++s.expire < 20){
        s.x = (1 - s.expire*s.expire/400)*s.x0 + s.expire*-4.6 + Math.sin(s.expire/20*Math.PI)*s.xvel;
        s.y = (1 - s.expire*s.expire/400)*s.y0 + s.expire*-2.05 + Math.sin(s.expire/20*Math.PI)*s.yvel;
      } else s.gone = true;
    }
  } else if(M.dieCounter===41){
    E.people--;
    M.dead = true;
    harvestSouls(M.souls, M.level);
  }
}
function pickup(M, res){
  M.resource = res;
  if(M.up && res.type<7) res.type++;
  M.seekDelay = Math.trunc(10/M.speed);
  M.exp += res.type * M.multiplier;
}
function classUp(M){
  const roll = Math.random()*(E.education+100);
  if(M.curClass===0 && roll>30){
    becomeClass(M, Math.floor(Math.random()*5)*3 + 1);
    return;
  }
  const th = {1:[40,2],2:[50,3],4:[50,5],5:[60,6],7:[70,8],8:[40,9],
    10:[40,11],11:[70,12],13:[70,14],14:[90,15]}[M.curClass];
  if(th && roll>th[0]) becomeClass(M, th[1]);
}
function becomeClass(M, id){
  const spec = CLASS_SPEC[id];
  if(!spec || !E.c[id-1] || M.level < spec.minLv) return;
  M.curClass = id;
  M.multiplier = spec.mult;
  M.likes = spec.likes.slice();
  M.up = spec.up;
}

//////////////////// upgrades (FoSControls click handlers) ////////////////////
function upgradeCost(kind){
  if(kind==='speed') return Math.floor(E.lvSpeed/5);
  if(kind==='life')  return Math.floor(E.lvLife/10);
  if(kind==='sight') return Math.floor(E.lvSight/10);
  if(kind==='land')  return Math.floor(E.lvLand/3);
}
function upgradeClick(kind){
  const lvKey = {speed:'lvSpeed',life:'lvLife',sight:'lvSight',land:'lvLand'}[kind];
  let n = E.shift ? 10 : 1;
  if(kind==='land'){
    while(n-- && E.souls >= upgradeCost('land')){
      const c = upgradeCost('land');
      E.souls -= c; E.burned += c;
      E.lvLand++;
      addLand();
      updateSouls();
    }
    return;
  }
  if(!E.ctrl){
    while(n-- && E.souls >= upgradeCost(kind)){
      const c = upgradeCost(kind);
      E.souls -= c; E.burned += c;
      E[lvKey]++;
    }
  } else {
    while(n-- && E[lvKey] > 10){
      E[lvKey]--;
      const c = upgradeCost(kind);
      E.souls += c;
      E.recSouls = E.souls;      // refund is not "earned"
      E.burned -= c;
    }
  }
  updateSouls();
}

//////////////////// achievements check (AchievementPane.updateAchievements) ////////////////////
function updateAchievements(){
  E.playtime++;
  const r = E.r;
  if(!E.a[0] && r[0]>=100) earnAchievement(0);
  else if(!E.a[1] && r[1]>=100) earnAchievement(1);
  else if(!E.a[2] && r[0]>=1000) earnAchievement(2);
  else if(!E.a[3] && r[2]>=100) earnAchievement(3);
  else if(!E.a[4] && r[3]>=100) earnAchievement(4);
  else if(!E.a[5] && r[4]>=1000) earnAchievement(5);
  else if(!E.a[6] && r[5]>=100) earnAchievement(6);
  else if(!E.a[7] && r[6]>=100) earnAchievement(7);
  else if(!E.a[8] && r[5]+r[6]>=1000) earnAchievement(8);
  else if(!E.a[9] && r[0]+r[1]+r[2]>=1) earnAchievement(9);
  else if(!E.a[10] && E.totSouls>=100) earnAchievement(10);
  else if(!E.a[11] && E.maxLv>=20) earnAchievement(11);
  else if(!E.a[12] && E.lvLand+E.lvLife+E.lvSight+E.lvSpeed>=100) earnAchievement(12);
  else if(!E.a[13] && E.people>=100) earnAchievement(13);
  else if(!E.a[14] && E.souls>=10000) earnAchievement(14);
  else if(!E.a[15] && E.playtime>=1260) earnAchievement(15);
  else if(!E.a[16] && E.playtime>=5400) earnAchievement(16);
  else if(!E.a[17] && r[0]>=2500) earnAchievement(17);
  else if(!E.a[18] && E.lvLand>=100) earnAchievement(18);
  else if(!E.a[19] && E.totSouls>=10000) earnAchievement(19);
  else if(!E.a[20] && E.burned>=10000) earnAchievement(20);
  else if(!E.a[21] && r[5]+r[6]>=100) earnAchievement(21);
  else if(!E.a[22] && E.lvSight>=100) earnAchievement(22);
  else if(!E.a[23] && r[1]>=1000) earnAchievement(23);
  else if(!E.a[24] && E.b>=100) earnAchievement(24);
  else if(!E.a[25] && E.reincarn>=1000) earnAchievement(25);
  else if(!E.a[26] && E.spawn>=1000) earnAchievement(26);
  else if(!E.a[27] && E.b>=20) earnAchievement(27);
  else if(!E.a[28] && E.lvSpeed>=100) earnAchievement(28);
  else if(!E.a[29] && E.b>=10) earnAchievement(29);
  else if(!E.a[30] && E.b>=50) earnAchievement(30);
  // Achievement.render state machine
  for(let i=0;i<31;i++){
    if(achOpen && achState[i]===1) achState[i]=2;
    else if(!achOpen && achState[i]===2) achState[i]=3;
  }
}

//////////////////// frame (Earth.onFrame + FoSControls.onFrame) ////////////////////
function onFrame(){
  controlsFrame();
  if(!E.paused){
    for(const L of land) landFrame(L);
  }
  for(let i=men.length-1;i>=0;i--){
    const M = men[i];
    if(!E.paused){
      if(M.dying) manDie(M); else manLive(M);
    }
    if(M.dead) men.splice(i,1);
  }
  E.submitDelay++;
  if(E.submitDelay%30===0){
    updateAchievements();
    E.averagePop += (E.people - E.averagePop) / E.playtime;
    if(E.people > E.recordPop) E.recordPop = E.people;
    updateProperties();
  }
  if(E.submitDelay>900){
    if(E.autosave) onSave();
    E.submitDelay = 0;
  }
  // splashes (AchievementSplash.onFrame)
  for(let i=splashes.length-1;i>=0;i--){
    const s = splashes[i];
    if(s.x > -124.9) s.x -= 25;
    else if(s.alpha > 0){
      s.x = -125;
      s.curAlpha -= 0.02;
      if(s.curAlpha < 1) s.alpha = Math.max(0, s.curAlpha);
    } else splashes.splice(i,1);
  }
}
function controlsFrame(){
  if(E.goingLeft===E.goingRight){
    E.camVel -= E.camVel/5;
    if(Math.abs(E.camVel)<0.1) E.camVel = 0;
  }
  else if(E.goingLeft) E.camVel += (1-E.camVel/10)/3;
  else if(E.goingRight) E.camVel -= (1+E.camVel/10)/3;
  E.camX -= E.camVel;
  if(E.shift) E.camX -= E.camVel*5;
  if(E.camX < E.leftBound+100){ E.camX = E.leftBound+100; E.camVel = 0; }
  else if(E.camX > E.rightBound-100){ E.camX = E.rightBound-100; E.camVel = 0; }
  if(!E.paused){
    skyX -= 1/3;
    if(skyX <= -1775) skyX = 25;
  }
  if(!hasSoul && E.souls>0 && E.people<E.supply){
    hasSoul = true;
    E.souls--;
    updateSouls();
  }
  E.saveTimer--;
}

//////////////////// save / load (SharedObject "FoSEarth<slot>") ////////////////////
function slotKey(slot){ return 'FoSRevampedEarth'+slot; }
function saveSO(){
  try{
    const d = { version:10,
      speed:E.lvSpeed, life:E.lvLife, sight:E.lvSight, land:E.lvLand,
      souls:E.souls + E.people + 1,
      totSouls:E.totSouls, resource:E.resource, maxLv:E.maxLv,
      achievements:E.a, resourceCounts:E.r, reincarn:E.reincarn, classes:E.c,
      time:E.playtime, spawn:E.spawn, burn:E.burned,
      building:[], stashResources:[], stashBuildings:[] };
    for(let i=0;i<E.lvLand;i++){
      if(land[i] && land[i].hasBuilding){
        d.building[i] = land[i].buildingType;
        d.stashResources[i] = land[i].hasStash ? land[i].stash.r : 0;
        d.stashBuildings[i] = land[i].hasStash ? land[i].stash.b : 0;
      } else {
        d.building[i] = -1;
        d.stashResources[i] = 0;
        d.stashBuildings[i] = 0;
      }
    }
    localStorage.setItem(slotKey(game.slot), JSON.stringify(d));
    return true;
  }catch(e){ return false; }
}
function loadSO(){
  try{
    const raw = localStorage.getItem(slotKey(game.slot));
    if(!raw) return false;
    const d = JSON.parse(raw);
    if(d.version!==10) return false;
    E.lvSpeed=d.speed; E.lvLife=d.life; E.lvSight=d.sight; E.lvLand=d.land;
    E.souls=d.souls;
    E.totSouls=d.totSouls;
    E.resource=d.resource - 1; // quirk preserved from the original loadSO
    E.maxLv=d.maxLv;
    E.recSouls=E.souls;
    E.a = (d.achievements||[]).map(Boolean); E.a.length=31;
    for(let i=0;i<31;i++){ E.a[i]=!!E.a[i]; achState[i] = E.a[i]?3:0; }
    E.r = d.resourceCounts||[0,0,0,0,0,0,0];
    E.reincarn=d.reincarn;
    E.c = (d.classes||[]).map(Boolean); E.c.length=15;
    for(let i=0;i<15;i++) E.c[i]=!!E.c[i];
    E.playtime=d.time; E.spawn=d.spawn; E.burned=d.burn;
    for(let i=0;i<E.lvLand;i++) addLand();
    for(let i=0;i<E.lvLand;i++){
      if(d.building[i]!==-1){
        E.hasStash = true;
        landBuild(land[i], d.building[i]);
        if(land[i].hasStash){
          land[i].stash.r = d.stashResources[i]||[0,0,0,0,0,0,0];
          if(Array.isArray(d.stashBuildings[i])) land[i].stash.b = d.stashBuildings[i];
        }
      }
    }
    return true;
  }catch(e){ return false; }
}
// FoSControls.onSave
function onSave(){
  if(E.saveTimer<=0){
    if(saveSO()) toolTip('Saved.');
    else toolTip('Saved old version, stats not submitted.');
    E.saveTimer = 30;
  }
}

//////////////////// start game (Main.startGame / Earth ctor) ////////////////////
function startGame(slot){
  game.slot = slot;
  E = newEarth();
  land = []; men = [];
  hasSoul = false; dragSoul = null;
  splashes = []; achState = new Array(31).fill(0);
  infoOpen = achOpen = classOpen = false;
  achOffset = 0; classHelp = 0;
  for(let i=0;i<5;i++) sbOffsets[i]=0;
  tooltip = '';
  let loaded = false;
  if(game.load) loaded = loadSO();
  else { try{ localStorage.removeItem(slotKey(slot)); }catch(e){} }
  if(game.load && !loaded) toolTip('No save found, new game started');
  if(land.length===0) for(let i=0;i<E.lvLand;i++) addLand();
  updateProperties();
  game.mode = 'play';
}

//////////////////// audio (Into the Second Dimension, restored from itsd.mp3) ////////////////////
let musicEl=null;
function initAudio(){
  if(musicEl) return;
  musicEl = new Audio('art/itsd.mp3');
  musicEl.loop = true;
  musicEl.volume = muted?0:volume/10;
  musicEl.play().catch(()=>{});
}
function applyVolume(){ if(musicEl) musicEl.volume = muted?0:volume/10; }
function onMute(){
  if(muted){ muted=false; applyVolume(); toolTip('Playing: Into the Second Dimension'); }
  else { muted=true; applyVolume(); toolTip('Muted.'); }
}
function volumeUp(){ if(volume<10)volume++; toolTip('Volume: '+(volume*10)+'%'); applyVolume(); }
function volumeDown(){ if(volume>1)volume--; toolTip('Volume: '+(volume*10)+'%'); applyVolume(); }

//////////////////// canvas ////////////////////
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

function di(name, lx, ly, w, h){ // draw image at logical coords/size
  const im = IMG[name];
  if(im && im.width) ctx.drawImage(im, LX(lx), LY(ly), (w||im.width)*SC, (h||im.height)*SC);
}

//////////////////// ClickPane registry (controls-local hotspots) ////////////////////
// Each: [x,y,w,h, onClick|null, tooltip, id]
function controlPanes(){
  const P = [
    [-39,-43,64,7, ()=>upgradeClick('speed'), 'Hotkey 1: Worker speed. Ctrl to sell, shift for 10.'],
    [-39,-35,64,7, ()=>upgradeClick('life'),  'Hotkey 2: Worker longevity, 1.5 seconds per point. Ctrl to sell, shift for 10.'],
    [-39,-27,64,7, ()=>upgradeClick('sight'), 'Hotkey 3: Range to spot resources, 1/4 tile per point. Ctrl to sell, shift for 10.'],
    [-39,-19,64,7, ()=>upgradeClick('land'),  "Hotkey 4: Tiles of land owned. Can't be sold."],
    [31,-19,10,7, onMute,    'Hotkey M: Click to mute. + and - keys change volume.'],
    [42,-19,10,7, ()=>{},    "Hotkey Q: You won't really see the effect in a pixel game."],
    [53,-19,10,7, onPause,   'Hotkey P: Pause the game.'],
    [64,-19,19,7, ()=>window.open('http://www.kongregate.com/accounts/Siveran'), 'By Siveran on Kongregate.'],
    [31,-27,10,7, onSave,    'Hotkey Z: Save the game. Workers are not saved.'],
    [42,-27,10,7, onInfo,    'Hotkey I: More options and info.'],
    [53,-27,10,7, onAchievement, 'Hotkey X: Achievements.'],
    [64,-27,10,7, onClasses, 'Hotkey C: Edit class tree.'],
    [75,-27,25,7, ()=>window.open('http://www.kongregate.com/'), 'Posted to one, stolen by many!'],
    [31,-35,38,7, null, 'Total resources, regardless of type or use.'],
    [31,-43,38,7, null, 'Maximum happiness level of all who have died.'],
    [31,-51,38,7, null, 'Total number of souls earned.'],
    [-70,-50,10,7, null, 'Current souls. Does not include the active soul.'],
    [-70,-31,10,7, null, 'Current number/limit'],
  ];
  return P;
}
function onPause(){ E.paused = !E.paused; }
function onInfo(){ infoOpen = !infoOpen; }
function onAchievement(){ achOpen = !achOpen; if(classOpen) classOpen=false; }
let classGender = [];
function onClasses(){
  classOpen = !classOpen;
  if(achOpen) achOpen=false;
  // UnitClass picks a random gender each time the tree is opened
  if(classOpen) classGender = CLASS_SLOTS.map(()=>Math.random()>0.5);
}

// info pane hotspots in LOGICAL coords (pane is fullscreen at logical 0,0)
const STATS_ROWS = [
  ['Buildings','Total number of buildings.', ()=>''+E.b],
  ['Rec. Pop.','Highest population reached.', ()=>''+E.recordPop],
  ['Achievements','Number of achievements earned.', ()=>''+E.a.filter(Boolean).length],
  ['Play Time','In-game days played (each day is 3 minutes).', ()=>(E.playtime/180).toFixed(1)],
  ['Burned',"The number of souls you've spent on stats.", ()=>''+E.burned],
  ['Reincarn',"The number of souls you've made humans with.", ()=>''+E.reincarn],
  ['Spawned','Number of people spawned from houses.', ()=>''+E.spawn],
];
function adjustEff(key, ev){
  if(ev && ev.ctrlKey) E[key]-=10; else E[key]+=10;
  if(E[key]>100) E[key]=0; else if(E[key]<0) E[key]=100;
}
const OPTIONS_ROWS = [
  ['Autosave','Game is saved every 30 seconds if on. Click to toggle.',
    ()=>E.autosave?'On':'Off', ()=>{ E.autosave=!E.autosave; }],
  ['Tips','Toggle tips, such as this one. Leads to confusion. Click to toggle.',
    ()=>E.showTips?'On':'Off', ()=>{
      if(E.showTips){ tooltip=''; E.showTips=false; }
      else { E.showTips=true; toolTip('H: Click to toggle help.'); } }],
  ['Eff. Rel.','Percent religion in effect. Click to change by 10.', ()=>E.effRel+'%', ev=>adjustEff('effRel',ev)],
  ['Eff. Enr.','Percent enrichment in effect. Click to change by 10.', ()=>E.effEnr+'%', ev=>adjustEff('effEnr',ev)],
  ['Eff. Edu.','Percent education in effect. Click to change by 10.', ()=>E.effEdu+'%', ev=>adjustEff('effEdu',ev)],
  ['Eff. Ref.','Percent refinement in effect. Click to change by 10.', ()=>E.effRef+'%', ev=>adjustEff('effRef',ev)],
  ['Eff. Hou.','Percent housing in effect. Click to change by 10.', ()=>E.effHou+'%', ev=>adjustEff('effHou',ev)],
  ['Eff. Sup.','Percent supply in effect. Click to change by 10.', ()=>E.effSup+'%', ev=>adjustEff('effSup',ev)],
];
const HELP_ROWS = [
  ['Turn Tooltips On',"If you can see this, then you're good."],
  ['Scrolling','Use W/S/Down/Up to scroll. Yes, they scroll simultaneously.'],
  ['Building Info','Clicking on a building shows how many resources it took to build.'],
  ['Building Flavor','Clicking twice on some buildings gives you some flavor text.'],
  ['Resource Weight','Clay, wood, and dirt can be picked up by level ones. Other resources take higher levels.'],
  ['Days','Each day is approximately 3 minutes long.'],
  ['Class Tree',"If you turn on scavenger and scholar in the class tree,\na lot more people will become scavengers than scholars becuase it's easier."],
  ['Hold Keys','Hold space for lots of people. Same principle works for all hotkeys.'],
  ['Number Cap','You can only have 2.1 billion at a time. It flips around to negative after that.'],
  ['Eff. Properties','You can ctrl+click on an eff. property to go 10% down instead of 10% up.'],
  ['Updates',"This game updates fairly irregularly and occasionally rapidly, and I listen to suggestions.\nSay something that you'd like to see in the game in the comments, and I might make it!"],
];
const CREDITS_ROWS = [
  ['Siveran','Art, programming, design, whatnot.'],
  ['AngelsDontKill11','The awesome music, Into the Second Dimension. Check out Fluffatron on Newgrounds to download it.'],
  ['Andrew Tyler','Pixelmix font.'],
];
const MISC_ROWS = [ ['Coming Soon','Quit buttons.'] ];
// scrollboxes: [x, y, width, slots, rows-array, hasRight]
const SCROLLBOXES = [
  [6,33,68,8, STATS_ROWS, true],
  [88,33,69,8, OPTIONS_ROWS, true],
  [171,33,68,8, HELP_ROWS, false],
  [88,112,69,3, CREDITS_ROWS, false],
  [171,112,68,3, MISC_ROWS, false],
];
function barTips(){
  return [
    'Current religion is '+E.religion+'. An average of '+(E.religion/100).toPrecision(2)+' extra souls are generated per happiness level.',
    'Current enrichment is '+E.fertility+'. Resources spawn '+((5+E.fertility*20)/(5+E.fertility)).toPrecision(2)+' times faster than normal.',
    'Current education is '+E.education+'. Raises the rate at which people become new classes.',
    'Current refinement is '+E.refinement+'. The refinement resource multiplier is '+(1+E.refinement/100).toPrecision(2)+'x.',
    'Current housing is '+E.housing+'. '+E.housing+' people spawn every in-game day.',
    'Current supply is '+E.supply+'. The land can support '+E.supply+' people alive at a time.',
  ];
}
const BAR_IMG = ['InfoPane_RelImage','InfoPane_EnrImage','InfoPane_EduImage',
  'InfoPane_RefImage','InfoPane_HouImage','InfoPane_SupImage'];
function barCounts(){
  return [
    Math.floor(73*E.religion/(E.religion+100)),
    Math.floor(73*E.fertility/(E.fertility+100)),
    Math.floor(73*E.education/(E.education+100)),
    Math.floor(73*E.refinement/(E.refinement+100)),
    Math.floor(0.73*E.effHou*E.housing/(E.housing*E.effHou/100+100)),
    Math.floor(73*E.supply/(E.supply+500)),
  ];
}
// class tree icon slots: [type, x, y]; slot visible if E.a[type-1] (type 0 always)
const CLASS_SLOTS = [
  [0,14,11],[1,44,15],[2,44,32],[3,44,49],[4,74,15],[5,74,32],[6,74,49],
  [7,104,15],[8,104,32],[9,104,49],[10,134,15],[11,134,32],[12,134,49],
  [13,164,15],[14,164,32],[15,164,49],
];

//////////////////// hover / hit testing ////////////////////
let hoverPane = null;        // key of hovered clickable pane (for highlight)
let scrollHover = 0;         // -1 left, 1 right, 0 none
let goHover = false;         // pause GoButton hover
function mouseLogical(e){
  const r = canvas.getBoundingClientRect();
  const mx = (e.clientX-r.left)*(STAGE_W/r.width), my = (e.clientY-r.top)*(STAGE_H/r.height);
  return { lx:(mx-OX)/SC, ly:(my-OY)/SC };
}
function inRect(lx,ly, x,y,w,h){ return lx>=x && lx<x+w && ly>=y && ly<y+h; }

// returns {tip, click, key, highlight:[x,y,w,h in logical], clickable} for topmost hit
function hitTest(lx, ly){
  const cx = lx-125, cy = ly-70;   // controls-local
  // pause overlay on top
  if(game.mode==='play' && E.paused){
    if(inRect(cx,cy,-30,0,60,30)) return { key:'go', click:()=>{ E.paused=false; } };
    return { key:'inTheWay' };
  }
  // info pane (fullscreen)
  if(infoOpen){
    if(inRect(lx,ly,234,2,14,14)) return { key:'infoClose', click:()=>{ infoOpen=false; },
      tip:'Close this panel.', hl:[234,2,14,14], clickable:true };
    for(let b=0;b<SCROLLBOXES.length;b++){
      const [bx,by,bw,slots,rows] = SCROLLBOXES[b];
      for(let row=0; row<slots; row++){
        const i = sbOffsets[b]+row;
        if(i>=rows.length) break;
        if(inRect(lx,ly,bx,by+row*8,bw,7)){
          const R = rows[i];
          const cb = R[3] || null;
          return { key:'sb'+b+'_'+i, tip:R[1], click:cb?(ev)=>cb(ev):null,
            hl:[bx,by+row*8,bw,7], clickable:!!cb };
        }
      }
    }
    const tips = barTips();
    for(let i=0;i<6;i++){
      if(inRect(lx,ly,7,102+6*i,72,5))
        return { key:'bar'+i, tip:tips[i], hl:[7,102+6*i,72,5], clickable:false };
    }
    return { key:'infoPane' };  // pane blocks everything under it
  }
  // achievement pane at controls (-97,-20) -> logical (28,50), 190x70
  if(achOpen){
    const px = lx-28, py = ly-50;
    if(px>=0 && px<190 && py>=0 && py<70){
      for(let row=0; row<6; row++){
        const i = achOffset+row;
        if(i>=31) break;
        const w = Math.min(184, textW(ACH[i][0],6)/SC + 2);
        if(inRect(px,py,3,15+row*8,w,8))
          return { key:'ach'+i, tip:ACH[i][1] };
      }
      return { key:'achPane' };
    }
  }
  // class tree pane at controls (-86,-20) -> logical (39,50), 186x70
  if(classOpen){
    const px = lx-39, py = ly-50;
    if(px>=0 && px<186 && py>=0 && py<70){
      if(inRect(px,py,14,39,7,13))
        return { key:'classHelp', clickable:true, hl2:[39+14,50+39,7,13],
          tip:'Click this to read through class tree instructions.', click:()=>{
          classHelp++;
          toolTip(CLASSTREE_HELP[classHelp-1]);
          if(classHelp>=9) classHelp=0;
        }};
      for(const [type,ux,uy] of CLASS_SLOTS){
        if(type!==0 && !E.a[type-1]) continue;
        if(inRect(px,py,ux,uy,10*2/3,20*2/3)){
          return { key:'class'+type, tip:CLASS_TIP[type], click: type===0?null:()=>{
            E.c[type-1] = !E.c[type-1];
          }};
        }
      }
      return { key:'classPane' };
    }
  }
  // main control panes
  for(const P of controlPanes()){
    if(inRect(cx,cy,P[0],P[1],P[2],P[3]))
      return { key:'cp'+P[0]+'_'+P[1], tip:P[5], click:P[4],
        hl2:[CLX(P[0]),CLY(P[1]),P[2],P[3]], clickable:!!P[4] };
  }
  // pod soul
  if(hasSoul && inRect(cx,cy,-92,-41,10,10))
    return { key:'soul', tip:'Active soul. Drag, click, or space to spawn.', soul:true };
  // left/right scroll zones
  if(inRect(cx,cy,-100,0,10,65))
    return { key:'scrollL', scroll:-1, click:()=>{ E.camX = E.leftBound*2/3; },
      tip:'Hotkey A/left: Click to go far left, shift to go faster.',
      hl2:[CLX(-100),CLY(0),10,65], clickable:true };
  if(inRect(cx,cy,90,0,10,65))
    return { key:'scrollR', scroll:1, click:()=>{ E.camX = E.rightBound*2/3; },
      tip:'Hotkey D/right: Click to go far right, shift to go faster.',
      hl2:[CLX(90),CLY(0),10,65], clickable:true };
  // buildings / resources (earth space)
  const wx = lx-125+E.camX, wy = ly-70;
  for(const L of land){
    if(L.hasBuilding){
      const im = IMG[buildingSprite(L.buildingType)];
      const off = BUILD_OFF[L.buildingType];
      if(im && im.width && inRect(wx,wy, L.x+10+off[0], 45+off[1], im.width, im.height))
        return { key:'b'+L.index, building:L,
          tip:[BUILD_TIP0,BUILD_TIP1,BUILD_TIP2][L.tip||0][L.buildingType],
          click:()=>{
            L.tip = (L.tip||0)<2 ? (L.tip||0)+1 : 0;
            toolTip([BUILD_TIP0,BUILD_TIP1,BUILD_TIP2][L.tip][L.buildingType]);
          }};
    }
    if(L.resource && inRect(wx,wy, L.x+5,35,10,10))
      return { key:'r'+L.index, tip:RES_TIP[L.resource.type] };
  }
  return null;
}

//////////////////// input ////////////////////
let lastHoverKey = null;
canvas.addEventListener('mousemove', e=>{
  const {lx,ly} = mouseLogical(e);
  mouseCL.x = lx-125; mouseCL.y = ly-70;
  if(dragSoul){ dragSoul.x = mouseCL.x-5; dragSoul.y = mouseCL.y-5; }
  if(game.mode!=='play'){ game.menuMouse={lx,ly}; return; }
  const h = hitTest(lx,ly);
  goHover = !!(h && h.key==='go');
  hoverPane = h && (h.hl||h.hl2) ? h : null;
  scrollHover = h && h.scroll ? h.scroll : 0;
  if(h && h.scroll){ if(h.scroll<0){E.goingLeft=true;E.goingRight=false;} else {E.goingRight=true;E.goingLeft=false;} }
  else if(scrollZoneWasHover){ E.goingLeft=E.goingRight=false; }
  scrollZoneWasHover = !!(h && h.scroll);
  const key = h ? h.key : null;
  if(key!==lastHoverKey){
    // Building.onOut: leaving a building resets its tip cycle
    if(lastHoverBuilding && (!h || h.building!==lastHoverBuilding)) lastHoverBuilding.tip = 0;
    lastHoverBuilding = h && h.building ? h.building : null;
    lastHoverKey = key;
    if(h && h.tip!==undefined && h.tip!==null) toolTip(h.tip);
  }
});
let lastHoverBuilding = null;
let scrollZoneWasHover = false;
canvas.addEventListener('mouseleave', ()=>{
  if(E){ E.goingLeft=E.goingRight=false; }
  scrollZoneWasHover=false; hoverPane=null; scrollHover=0; lastHoverKey=null; goHover=false;
});
canvas.addEventListener('mousedown', e=>{
  initAudio();
  const {lx,ly} = mouseLogical(e);
  if(game.mode!=='play') return menuClick(lx,ly);
  const h = hitTest(lx,ly);
  if(h && h.soul && !dragSoul){
    dragSoul = { x:lx-125-5, y:ly-70-5 };
    hasSoul = false;
  }
});
canvas.addEventListener('mouseup', e=>{
  if(game.mode!=='play') return;
  const {lx,ly} = mouseLogical(e);
  if(dragSoul){
    onDropSoul();
    return;
  }
  const h = hitTest(lx,ly);
  if(h && h.click) h.click(e);
});
window.addEventListener('blur', ()=>{ if(dragSoul) onDropSoul(); });
function onDropSoul(){
  if(!dragSoul) return;
  if(!dropSoul(dragSoul.x + 5 + E.camX)) E.souls++;
  dragSoul = null;
  E.reincarn++;
}
canvas.addEventListener('wheel', e=>{
  if(game.mode!=='play') return;
  const d = e.deltaY<0 ? 1 : -1;
  let scrolled = false;
  if(achOpen){ achScroll(d); scrolled = true; }
  if(infoOpen){ sbScroll(d); scrolled = true; }
  if(scrolled){
    e.preventDefault();
    toolTip('Use W/Up and S/Down, not the mouse wheel.');
  }
},{passive:false});
function achScroll(d){
  achOffset -= d;
  if(achOffset<0) achOffset=0;
  else if(achOffset>=31) achOffset=30;
}
function sbScroll(d){
  for(let b=0;b<SCROLLBOXES.length;b++){
    sbOffsets[b] -= d;
    if(sbOffsets[b]<0) sbOffsets[b]=0;
    else if(sbOffsets[b]>=SCROLLBOXES[b][4].length) sbOffsets[b]=SCROLLBOXES[b][4].length-1;
  }
}

window.addEventListener('keydown', e=>{
  if(game.mode!=='play') return;
  if(E.keytipcount<10){
    toolTip('Left/A and right/D keys pan, space drops souls.');
    E.keytipcount++;
  }
  switch(e.key.toLowerCase()){
    case 'arrowleft': case 'a': E.goingLeft = true; break;
    case 'arrowright': case 'd': E.goingRight = true; break;
    case 'shift': E.shift = true; break;
    case 'control': E.ctrl = true; break;
    case ' ':
      e.preventDefault();
      if(!E.paused){
        if(hasSoul && !dragSoul){ dragSoul = { x:mouseCL.x-5, y:mouseCL.y-5 }; hasSoul = false; }
        if(dragSoul){ dragSoul.x = mouseCL.x-5; dragSoul.y = mouseCL.y-5; onDropSoul(); }
      }
      break;
    case '1': upgradeClick('speed'); break;
    case '2': upgradeClick('life'); break;
    case '3': upgradeClick('sight'); break;
    case '4': upgradeClick('land'); break;
    case 'm': onMute(); break;
    case 'q': break;                       // stage quality: no visible effect
    case 'escape': case 'p': onPause(); break;
    case 'z': onSave(); break;
    case 'i': onInfo(); break;
    case 'x': onAchievement(); break;
    case 'c': onClasses(); break;
    case '+': case '=': volumeUp(); break;
    case '-': volumeDown(); break;
    case 'w': case 'arrowup':
      if(achOpen) achScroll(1);
      if(infoOpen) sbScroll(1);
      break;
    case 's': case 'arrowdown':
      if(achOpen) achScroll(-1);
      if(infoOpen) sbScroll(-1);
      break;
  }
});
window.addEventListener('keyup', e=>{
  if(!E) return;
  switch(e.key.toLowerCase()){
    case 'arrowleft': case 'a': E.goingLeft = false; break;
    case 'arrowright': case 'd': E.goingRight = false; break;
    case 'shift': E.shift = false; break;
    case 'control': E.ctrl = false; break;
  }
});

//////////////////// menu ////////////////////
const MENU_ITEMS = [
  ['New Game',80], ['Continue',90], ['Play v0.0.8 Right Here',100],
  ['Game and Art by Siveran',110], ['Music by AngelsDontKill11',120]];
const SLOT_ITEMS = [ ['Slot 1',80], ['Slot 2',90], ['Slot 3',100], ['Cancel',110] ];
let menuScreen = 'main';   // 'main' | 'slots'
function menuItems(){ return menuScreen==='main' ? MENU_ITEMS : SLOT_ITEMS; }
function menuHitIndex(lx,ly){
  const items = menuItems();
  for(let i=0;i<items.length;i++){
    const [t,y] = items[i];
    const w = textW(t,6)/SC;
    if(inRect(lx,ly, 125-w/2-2, y, w+4, 8)) return i;
  }
  return -1;
}
function menuClick(lx,ly){
  const i = menuHitIndex(lx,ly);
  if(i<0) return;
  if(menuScreen==='main'){
    if(i===0){ game.load=false; menuScreen='slots'; }
    else if(i===1){ game.load=true; menuScreen='slots'; }
    else if(i===3) window.open('http://www.kongregate.com/accounts/Siveran');
    else if(i===4) window.open('http://www.kongregate.com/accounts/AngelsDontKill11');
  } else {
    if(i===3) menuScreen='main';
    else startGame(i+1);
  }
}

//////////////////// render ////////////////////
let fpsText = '', fpsCounter = 0, fpsLast = 0;
function render(){
  ctx.clearRect(0,0,STAGE_W,STAGE_H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,STAGE_W,STAGE_H);
  if(game.mode==='loading'){ renderLoading(); return; }
  if(game.mode==='menu'){ renderMenu(); }
  else renderGame();
  // Main fps counter at (-7,-7), size 3
  if(++fpsCounter>=10){
    const now = performance.now();
    fpsText = ''+Math.round(10000/(now-fpsLast));
    fpsLast = now;
    fpsCounter = 0;
  }
  drawText(fpsText, LX(-7), LY(-7), 3, '#3d3d3d', 'left');
}
function renderLoading(){
  ctx.fillStyle = '#2727a7';
  ctx.fillRect(LX(0),LY(0),250*SC,150*SC);
  drawText('Loading...', LX(125), LY(100), 6, '#3d3d3d', 'center');
}
function renderMenu(){
  // Main.onKong: vertical gradient 0x002200 -> 0x001100 over the 250x150 scene
  const g = ctx.createLinearGradient(0,LY(0),0,LY(150));
  g.addColorStop(0,'#002200'); g.addColorStop(1,'#001100');
  ctx.fillStyle = g;
  ctx.fillRect(LX(0),LY(0),250*SC,150*SC);
  drawText('Farm of Souls\n0.1.7', LX(125), LY(30), 16, '#e5f0e5', 'center');
  const items = menuItems();
  const hov = game.menuMouse ? menuHitIndex(game.menuMouse.lx, game.menuMouse.ly) : -1;
  for(let i=0;i<items.length;i++){
    drawText(items[i][0], LX(125), LY(items[i][1]), 6, i===hov?'#e5f0e5':'#3d3d3d', 'center');
  }
}

function renderGame(){
  // 1. sky (stage-level, behind everything)
  const back = IMG['FoSControls_BackImage'];
  if(back && back.width){
    ctx.drawImage(back, skyX, 235, 1800, 195);
    ctx.drawImage(back, skyX+1800, 235, 1800, 195);
  }
  // 2. island: land tiles + resources + buildings (earth space), culled to camX±175
  for(const L of land){
    if(L.x <= E.camX-175 || L.x >= E.camX+175) continue;
    const gx = EX(L.x);
    di('Land_SpriteImage', gx, EY(0));
    if(L.hasBuilding){
      const off = BUILD_OFF[L.buildingType];
      di(buildingSprite(L.buildingType), gx+10+off[0], EY(45+off[1]));
    }
    if(L.resource) di('Resource_'+RES_SPRITE[L.resource.type]+'Image', gx+5, EY(35));
  }
  // 3. men
  for(const M of men){
    if(M.x <= E.camX-175 || M.x >= E.camX+175) continue;
    drawMan(M);
  }
  // 4. controls layer: background frame
  ctx.globalAlpha = 0.9;
  di('Background_Image1', 0, 0);
  di('Background_Image2', 25, 0);
  di('Background_Image3', 225, 75);
  di('Background_Image4', 25, 130);
  ctx.globalAlpha = 1;
  // black border outside 250x150
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,STAGE_W,OY);
  ctx.fillRect(0,0,OX,STAGE_H);
  ctx.fillRect(STAGE_W-OX,0,OX,STAGE_H);
  ctx.fillRect(0,STAGE_H-OY,STAGE_W,OY);
  // 5. scroll-zone hover highlight + pane highlight (ClickPane alpha behavior)
  if(hoverPane){
    const r = hoverPane.hl ? [LX(hoverPane.hl[0]),LY(hoverPane.hl[1]),hoverPane.hl[2]*SC,hoverPane.hl[3]*SC]
            : [LX(hoverPane.hl2[0]),LY(hoverPane.hl2[1]),hoverPane.hl2[2]*SC,hoverPane.hl2[3]*SC];
    ctx.fillStyle = hoverPane.clickable ? 'rgba(221,255,221,0.3)' : 'rgba(170,170,170,0.1)';
    ctx.fillRect(r[0],r[1],r[2],r[3]);
  }
  // 6. panel live text (FoSControls PixelTexts; controls-local coords)
  ctext(''+E.lvSpeed, 14,-45, 6, '#3d3d3d', 'center', 16);
  ctext(''+E.lvLife,  14,-37, 6, '#3d3d3d', 'center', 16);
  ctext(''+E.lvSight, 14,-29, 6, '#3d3d3d', 'center', 16);
  ctext(''+E.lvLand,  14,-21, 6, '#3d3d3d', 'center', 16);
  ctext(''+Math.floor(E.lvSpeed/5), -5,-45, 6, '#3d3d3d', 'center', 16);
  ctext(''+Math.floor(E.lvLife/10), -5,-37, 6, '#3d3d3d', 'center', 16);
  ctext(''+Math.floor(E.lvSight/10),-5,-29, 6, '#3d3d3d', 'center', 16);
  ctext(''+Math.floor(E.lvLand/3),  -5,-21, 6, '#3d3d3d', 'center', 16);
  ctext(''+E.souls, -65,-50, 6, '#3d3d3d', 'center', 25);
  ctext(E.people+'/'+E.supply, -65,-31, 6, '#3d3d3d', 'center', 25);
  ctext(''+E.totSouls, 70,-53, 6, '#3d3d3d', 'left', 30);
  ctext(''+E.maxLv,    70,-45, 6, '#3d3d3d', 'left', 30);
  ctext(''+E.resource, 70,-37, 6, '#3d3d3d', 'left', 30);
  // markers: small soul + person next to the counters
  const fs = IMG['FlyingSoul_SpriteImage'];
  if(fs && fs.width){
    const t = Math.floor(frameCount/15)%2;
    ctx.drawImage(fs, t*10,0,10,10, LX(CLX(-55.9)), LY(CLY(-52.8)), 10, 10); // scale 1/3
  }
  const pm = IMG['FoSControls_PersonImage'];
  if(pm && pm.width) ctx.drawImage(pm, LX(CLX(-55.6)), LY(CLY(-24)), 10, 20); // scale 1/3
  // 7. active pod soul / flying death souls / dragged soul (controls layer)
  if(hasSoul && fs && fs.width){
    const t = Math.floor(frameCount/15)%2;
    ctx.drawImage(fs, t*10,0,10,10, LX(CLX(-92)), LY(CLY(-41)), 10*SC, 10*SC);
  }
  for(const M of men){
    if(M.dying && M.dieCounter>20 && M.dieCounter<=40){
      for(const s of M.soularray){
        if(s.gone) continue;
        const t = Math.floor((frameCount+s.expire)/15)%2;
        if(fs && fs.width) ctx.drawImage(fs, t*10,0,10,10, LX(CLX(s.x)), LY(CLY(s.y)), 10*SC, 10*SC);
      }
    }
  }
  if(dragSoul && fs && fs.width){
    const t = Math.floor(frameCount/15)%2;
    ctx.drawImage(fs, t*10,0,10,10, LX(CLX(dragSoul.x)), LY(CLY(dragSoul.y)), 10*SC, 10*SC);
  }
  // 8. panes
  if(infoOpen) renderInfoPane();
  if(achOpen) renderAchPane();
  if(classOpen) renderClassPane();
  // 9. achievement splashes (just below tooltip text)
  for(const s of splashes){
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, s.alpha));
    const x0 = LX(CLX(s.x)), y0 = LY(CLY(-11));
    const g = ctx.createLinearGradient(x0,0,x0+250*SC,0);
    g.addColorStop(0,'rgba(221,255,221,0)');
    g.addColorStop(1,'rgba(221,255,221,1)');
    ctx.fillStyle = g;
    ctx.fillRect(x0,y0,250*SC,10*SC);
    const w = textW(s.text,6);
    drawText(s.text, x0+250*SC-w-2*SC, y0, 6, '#3d3d3d', 'left');
    ctx.restore();
  }
  // 10. tooltip (PixelText at controls (-2,67), color 0xDDFFDD, centered, max 250)
  if(tooltip) ctext(tooltip, -2, 67, 6, '#ddffdd', 'center', 250);
  // 11. pause overlay
  if(E.paused){
    ctx.fillStyle = 'rgba(0,16,0,0.4)';
    ctx.fillRect(LX(0),LY(0),250*SC,150*SC);
    di(goHover?'GoButton_State2':'GoButton_State1', CLX(-30), CLY(0), 60, 30); // GoButton scale 3
  }
}

function drawMan(M){
  const gx = EX(M.x), gy = EY(M.y);
  let name = null;
  if(M.dying){
    if(M.dieCounter<20) name = 'Man_TransitionImage';
  } else {
    name = 'Man_'+(M.male?'Male':'Female')+CLASS_SPRITE[M.curClass];
  }
  if(name){
    const im = IMG[name];
    if(im && im.width){
      if(M.facing<0){
        ctx.save();
        ctx.translate(LX(gx), LY(gy));
        ctx.scale(-1,1);
        ctx.drawImage(im, -5*SC, 0, 10*SC, 20*SC);
        ctx.restore();
      } else {
        ctx.drawImage(im, LX(gx-5), LY(gy), 10*SC, 20*SC);
      }
    }
  }
  if(!M.dying){
    // statbar (10x10 image at man-local (-5,30); pixels 3x1 stacked up from y=7)
    di('Statbar_SpriteImage', gx-5, gy+30);
    const h = Math.floor(8*M.life/M.maxLife);
    const ex = Math.floor(8*M.exp/M.level);
    const lifeIm = IMG['Statbar_Life'], expIm = IMG['Statbar_Experience'];
    for(let i=0;i<h;i++) if(lifeIm&&lifeIm.width) ctx.drawImage(lifeIm, LX(gx-5+1), LY(gy+30+7-i), 3*SC, 1*SC);
    for(let i=0;i<ex;i++) if(expIm&&expIm.width) ctx.drawImage(expIm, LX(gx-5+6), LY(gy+30+7-i), 3*SC, 1*SC);
    // level text at man-local (2,-5)
    drawText(''+M.level, LX(gx+2), LY(gy-5), 6, '#3d3d3d', 'left');
    // carried resource at (-5,20) + multiplier text at (5,22)
    if(M.resource){
      di('Resource_'+RES_SPRITE[M.resource.type]+'Image', gx-5, gy+20);
      drawText('x'+M.multiplier, LX(gx+5), LY(gy+22), 5, '#ccffcc', 'left');
    }
  }
}

function renderInfoPane(){
  di('InfoPane_SpriteImage', 0, 0);
  for(let b=0;b<SCROLLBOXES.length;b++){
    const [bx,by,bw,slots,rows] = SCROLLBOXES[b];
    const off = sbOffsets[b];
    for(let row=0; row<slots; row++){
      const i = off+row;
      if(i>=rows.length) break;
      const y = by + row*8 - 2;
      drawText(rows[i][0], LX(bx), LY(y), 6, '#cbe3ca', 'left', bw);
      if(rows[i][2]) drawText(rows[i][2](), LX(bx+bw), LY(y), 6, '#cbe3ca', 'right', bw);
    }
    // scrollbar (1x3 at x=w+3)
    if(rows.length>1){
      const barY = (slots*8-16)*off/(rows.length-1) + 5;
      ctx.fillStyle = '#d3d3d3';
      ctx.fillRect(LX(bx+bw+3), LY(by+barY), 1*SC, 3*SC);
    }
  }
  // property bars
  const counts = barCounts();
  for(let i=0;i<6;i++){
    const im = IMG[BAR_IMG[i]];
    if(im && im.width) ctx.drawImage(im, LX(7), LY(102+6*i), (counts[i]+1)*SC, 5*SC);
  }
}

function renderAchPane(){
  // pane at controls (-97,-20) -> logical (28,50)
  const px = 28, py = 50;
  di('AchievementPane_SpriteImage', px, py);
  for(let row=0; row<6; row++){
    const i = achOffset+row;
    if(i>=31) break;
    let color = '#3d3d3d';
    if(achState[i]===1||achState[i]===2) color = '#555500';
    else if(E.a[i]) color = '#005500';
    drawText(ACH[i][0], LX(px+3), LY(py+15+row*8), 6, color, 'left', 180);
  }
  ctx.fillStyle = '#232323';
  ctx.fillRect(LX(px+185), LY(py + achOffset*36/30 + 23), 1*SC, 3*SC);
}

function renderClassPane(){
  const px = 39, py = 50;   // controls (-86,-20)
  di('ClassTree_SpriteImage', px, py);
  for(const [type,ux,uy] of CLASS_SLOTS){
    if(type!==0 && !E.a[type-1]) continue;
    const im = IMG['Man_'+(classGender[type]?'Male':'Female')+CLASS_SPRITE[type]];
    if(!im || !im.width) continue;
    const w = 10*2/3, h = 20*2/3;
    if(type!==0 && !E.c[type-1]){
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(im, LX(px+ux), LY(py+uy), w*SC, h*SC);
      ctx.restore();
    } else {
      ctx.drawImage(im, LX(px+ux), LY(py+uy), w*SC, h*SC);
    }
  }
}

//////////////////// boot ////////////////////
function boot(){
  loadAssets(()=>{
    game.mode = 'menu';
    // debug hooks for headless testing: #autostart | #demo (autoplay + fast-forward)
    const h = location.hash;
    if(h==='#autostart' || h.startsWith('#demo')){
      game.load = false;
      startGame(1);
      if(h.startsWith('#demo')){
        const n = parseInt(h.split('=')[1]||'3600',10);
        for(let f=0; f<n; f++){
          onFrame();
          if(hasSoul){
            hasSoul = false;
            if(!dropSoul((Math.random()*2-1)*E.rightBound*0.8)) E.souls++;
            E.reincarn++;
          }
        }
      }
    }
  });
  let last = performance.now(), acc = 0;
  function loop(now){
    acc += now-last; last = now;
    if(acc>200) acc = 200;
    while(acc>=FRAME_MS){
      frameCount++;
      if(game.mode==='play') onFrame();
      acc -= FRAME_MS;
    }
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.addEventListener('beforeunload', ()=>{ if(game.mode==='play' && E.autosave) saveSO(); });
}
boot();
