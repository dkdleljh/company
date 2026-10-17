'use strict';
importScripts('./graph-model.js?v=1');
self.onmessage=({data})=>{
 try{const graph=self.CompanyGraph.build(data.documents,data.topics,text=>self.postMessage({type:'progress',text}));self.postMessage({type:'progress',text:'문서 연결을 배치하고 있습니다…'});self.postMessage({type:'ready',graph:self.CompanyGraph.layout(graph)});}
 catch{self.postMessage({type:'error',text:'그래프를 만들지 못했습니다. 다시 열어 주세요.'});}
};
