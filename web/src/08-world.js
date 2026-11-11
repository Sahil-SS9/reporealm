/* RepoRealm art direction: non-colliding architectural detail and a separate
 * menu scene sharing the game's one WebGL renderer. Never advances the sim. */
(function (SD) {
  'use strict';
  SD.Realm = SD.Realm || {};
  SD.Realm.trainingGoal = 'Place A and B. Cross the barrier, then walk through the exit.';
  var P = SD.Render.Renderer.prototype;
  function material(T, colour, glow) {
    return glow ? new T.MeshBasicMaterial({color:colour}) : new T.MeshStandardMaterial({color:colour,roughness:.38,metalness:.58});
  }
  function mesh(T, scene, geo, mat, x,y,z) {
    var m = new T.Mesh(geo,mat); m.position.set(x,y,z); scene.add(m); return m;
  }
  P.buildMenu = function () {
    if (this.menuScene) return;
    var T=this.THREE, s=this.menuScene=new T.Scene();
    s.background=new T.Color(0x130c25); s.fog=new T.FogExp2(0x21112f,.024);
    s.add(new T.HemisphereLight(0xe3baf2,0x1c1634,1.1));
    var key=new T.DirectionalLight(0xffbb81,2.2);key.position.set(4,12,6);s.add(key);
    var fill=new T.PointLight(0xff647e,2,35);fill.position.set(6,5,-3);s.add(fill);
    var cyan=new T.PointLight(0x6cb5cf,1.8,25);cyan.position.set(-4,4,0);s.add(cyan);
    var metal=material(T,0x352642), dark=material(T,0x1a1429),warm=material(T,0xffb96c,true),pink=material(T,0xd64e85,true);
    mesh(T,s,new T.CylinderGeometry(8,8.8,.7,96),metal,4,-.6,-3);
    mesh(T,s,new T.CylinderGeometry(7.3,7.3,.1,96),dark,4,-.18,-3);
    var floor=mesh(T,s,new T.PlaneGeometry(140,140),material(T,0x282137),0,-1,0);floor.rotation.x=-Math.PI/2;
    var portal=this.menuGateway=new T.Group();portal.position.set(4,3.7,-3);s.add(portal);
    var rings=this.menuRings=[];
    [3.65,3.92,4.25].forEach(function(r,i){
      var m=mesh(T,portal,new T.TorusGeometry(r,i===1?.045:.17,16,144),i===1?warm:metal,0,0,-i*.24);
      rings.push(m);
    });
    var inner=mesh(T,portal,new T.CircleGeometry(3.47,128),new T.ShaderMaterial({
      uniforms:{time:{value:0}},side:T.DoubleSide,
      vertexShader:'varying vec2 v; void main(){v=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader:'varying vec2 v;uniform float time;void main(){vec2 p=(v-.5)*2.;float r=length(p);float a=atan(p.y,p.x);float wave=sin(r*24.-time*.6+a*2.)*.5+.5;vec3 c=mix(vec3(.035,.025,.13),vec3(.28,.08,.4),wave*r);c+=vec3(.9,.24,.1)*pow(r,7.);gl_FragColor=vec4(c,1.);}'
    }),0,0,-.65);this.menuField=inner;
    for(var i=0;i<16;i++){
      var a=i*Math.PI/8;
      var lug=mesh(T,portal,new T.BoxGeometry(.38,.75,.48),dark,Math.sin(a)*4.05,Math.cos(a)*4.05,-.08);lug.rotation.z=-a;
      var light=mesh(T,portal,new T.BoxGeometry(.07,.38,.05),i%4?pink:warm,Math.sin(a)*4.05,Math.cos(a)*4.05,.19);light.rotation.z=-a;
    }
    // Receding paired gantries create real occlusion, depth and scale.
    for(var z=-12;z>-55;z-=9){
      [-7,15].forEach(function(x){
        mesh(T,s,new T.BoxGeometry(.65,11,.9),metal,x,4,z);
        mesh(T,s,new T.BoxGeometry(.065,8,.08),pink,x-.36,4,z+.48);
      });
      mesh(T,s,new T.BoxGeometry(22,.6,.8),metal,4,9.3,z);
    }
    for(var j=0;j<9;j++){
      mesh(T,s,new T.BoxGeometry(.06,.025,5),material(T,j%2?0x765b83:0xf5ae78,true),-4+j*2,-.93,5);
    }
    var pos=new Float32Array(110*3);
    for(var k=0;k<110;k++){pos[k*3]=Math.sin(k*31.3)*16+4;pos[k*3+1]=(k%17)*.6;pos[k*3+2]=-((k*7)%45);}
    var geo=new T.BufferGeometry();geo.setAttribute('position',new T.BufferAttribute(pos,3));
    this.menuDust=new T.Points(geo,new T.PointsMaterial({color:0xe8b0c4,size:.035,transparent:true,opacity:.65}));s.add(this.menuDust);
    this.menuCamera=new T.PerspectiveCamera(57,1,.1,150);
  };
  P.renderMenu = function (dt) {
    this.buildMenu();
    this.menuTime=(this.menuTime||0)+(this.reducedMotion?0:Math.min(dt,.05));
    var t=this.menuTime,c=this.menuCamera;
    c.aspect=this.camera.aspect;c.updateProjectionMatrix();
    c.position.set(-3+Math.sin(t*.12)*.2,3.7+Math.sin(t*.16)*.08,13);
    c.lookAt(-.5,3,-4);
    this.menuField.material.uniforms.time.value=t;
    this.menuRings[1].rotation.z=t*.04;
    this.menuDust.rotation.y=Math.sin(t*.04)*.025;
    this.renderer.setRenderTarget(null);this.renderer.render(this.menuScene,c);this.stats.frames++;
  };
  P.realmDecorate = function () {
    var T=this.THREE,g=this.geom,s=this.scene,h=g.layout.height,w=g.layout.width;
    var level=this.sim.level, later=this.sim.levelIndex>1;
    // Later rooms retain the approved alloy/value hierarchy. Their ceiling
    // signatures differ, not the physical puzzle or portalable surfaces.
    var tones={imports:0xd5b6d9,tests:0xa9cedb,relay:0xe2a7bd,weighbridge:0xf0c28c};
    var tone=tones[level.kind] || 0xd8bbaf;
    var alloy=material(T,0x352b46), dark=material(T,0x211a30), edge=material(T,0xc795ae), lamp=material(T,later?tone:0xd8bbaf,true);
    this.hemi.color.setHex(0xd9c6ee);this.hemi.groundColor.setHex(0x312534);this.hemi.intensity=.8;
    this.key.color.setHex(0xffd5ab);this.key.intensity=1.6;this.fill.color.setHex(0xbccbe8);this.fill.intensity=.55;
    s.fog=new T.Fog(0x282035,30,100);s.background=new T.Color(0x21192e);
    // Fluted roof ribs remain strictly above the walk/portal region. Repeated
    // asymmetric fins lead the eye along the route without inventing surfaces.
    for(var z=g.bounds.min.z+3;z<g.bounds.max.z;z+=4){
      mesh(T,s,new T.BoxGeometry(w-.12,.22,.32),alloy,0,h-.12,z);
      [-1,1].forEach(function(side){
        var fin=mesh(T,s,new T.BoxGeometry(.16,.75,.32),edge,side*(w/2-.07),h-.42,z);fin.rotation.z=side*.18;
        mesh(T,s,new T.BoxGeometry(.035,.025,2.7),lamp,side*(w/2-.1),h-1,z+1.3);
      });
    }
    // The split crown is the landmark of the exit; its opening is larger than
    // the proven door. Nothing added to the floor, route or portal mounts.
    var crown=new T.Shape();crown.moveTo(-1.8,2.7);crown.lineTo(-1.8,3.2);crown.lineTo(-1.3,3.65);crown.lineTo(1.3,3.65);crown.lineTo(1.8,3.2);crown.lineTo(1.8,2.7);crown.lineTo(1.5,2.7);crown.lineTo(1.5,3.05);crown.lineTo(1.15,3.35);crown.lineTo(-1.15,3.35);crown.lineTo(-1.5,3.05);crown.lineTo(-1.5,2.7);crown.closePath();
    mesh(T,s,new T.ExtrudeGeometry(crown,{depth:.15,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.04,bevelThickness:.03}),alloy,0,0,g.door.zPlane+(later?.04:-.24));
    // Keep the approved first-slice plaque; later rooms already have a title
    // sign supplied by levelgen, so do not stack a second label over EXIT.
    if (!later) {
      var tex=SD.Render.makeTextTexture({width:768,height:128,background:'#191225',lines:[{text:level.title.replace(/^CHAMBER\s+/i,''),size:44,color:'#f8d5a8'}]});
      mesh(T,s,new T.PlaneGeometry(3.0,.5),new T.MeshBasicMaterial({map:tex,side:T.DoubleSide}),0,Math.min(h-.7,4.2),g.door.zPlane-.32).rotation.y=Math.PI;
    }
    if (later) {
      // Flush ceiling-light landmarks: routing lanes, a guard bracket, paired
      // relay chevrons, and a balance beam. All geometry stays in the top .3 m;
      // no new floor object, collider, mount or line across an aperture.
      var zMark=g.bounds.min.z+(g.bounds.max.z-g.bounds.min.z)*.32;
      var span=Math.min(2.4,w*.22), roof=h-.28;
      function stroke(x,z,length,angle) {
        var line=mesh(T,s,new T.BoxGeometry(.055,.025,length),lamp,x,roof,z);
        line.rotation.y=angle || 0;
      }
      if (level.kind==='imports') {
        [-1,1].forEach(function(side){stroke(side*.65,zMark,3.0);stroke(side*.65,zMark+1.45,.8,side*Math.PI/4);});
      } else if (level.kind==='tests') {
        stroke(-span/2,zMark,2.4);stroke(span/2,zMark,2.4);stroke(0,zMark+1.2,span,Math.PI/2);
      } else if (level.kind==='relay') {
        [-.8,.8].forEach(function(z){stroke(-.4,zMark+z,1.15,-Math.PI/4);stroke(.4,zMark+z,1.15,Math.PI/4);});
      } else if (level.kind==='weighbridge') {
        stroke(0,zMark,span,Math.PI/2);stroke(0,zMark-.5,1);
        [-1,1].forEach(function(side){stroke(side*span/2,zMark+.4,.8);});
      }
    }
    // Terminal housings hug existing screens: bevelled corners and inset lip,
    // not an invisible new collider or a replacement of the evidence itself.
    g.terminals.forEach(function(t){
      var shape=new T.Shape(),hw=.94,hh=.61,b=.12;
      shape.moveTo(-hw+b,-hh);shape.lineTo(hw-b,-hh);shape.lineTo(hw,-hh+b);shape.lineTo(hw,hh-b);shape.lineTo(hw-b,hh);shape.lineTo(-hw+b,hh);shape.lineTo(-hw,hh-b);shape.lineTo(-hw,-hh+b);shape.closePath();
      var housing=mesh(T,s,new T.ExtrudeGeometry(shape,{depth:.06,bevelEnabled:true,bevelSegments:3,bevelSize:.035,bevelThickness:.025}),dark,t.pos.x+t.facing.x*.04,t.pos.y,t.pos.z+t.facing.z*.04);
      housing.rotation.y=Math.atan2(t.facing.x,t.facing.z);
    });
    // Inset door-leaf seams inherit their mesh motion; never span the doorway.
    g.door.leaves.forEach(function(leaf){
      var m=this.meshes[leaf.id];if(!m)return;
      var a=leaf.aabb,ww=a.max.x-a.min.x,hh=a.max.y-a.min.y,dd=a.max.z-a.min.z;
      [-1,1].forEach(function(side){mesh(T,m,new T.BoxGeometry(.025,hh*.7,.008),edge,side*ww*.3,0,-dd/2-.006);});
    },this);
    this.realmActive=true;
  };
})(window.SD);
