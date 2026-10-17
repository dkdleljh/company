"""Headless Notion MCP client using the existing Hermes OAuth token store."""
import asyncio,json,re,sys,time,uuid
from pathlib import Path

def unpack(result):
    value='\n'.join(getattr(x,'text','') for x in result.content if getattr(x,'text',''))
    for _ in range(6):
        if isinstance(value,str):
            try:value=json.loads(value);continue
            except ValueError:break
        if isinstance(value,dict) and set(value)=={'result'}:value=value['result'];continue
        break
    return value

def page_text(value):return value.get('text','') if isinstance(value,dict) else str(value)
def page_properties(value):
    m=re.search(r'<properties>\s*(\{.*?\})\s*</properties>',page_text(value),re.S)
    return json.loads(m.group(1)) if m else {}
def page_body(value):
    m=re.search(r'<content>\s*(.*?)\s*</content>',page_text(value),re.S)
    return m.group(1) if m else ''
def plain(value):
    text=str(value or '')
    for _ in range(5):
        clean=re.sub(r'\[([^\]]+)\]\([^)]+\)',r'\1',text)
        if clean==text:break
        text=clean
    return re.sub(r'\\([\\*~`$\[\]<>{}|^_])',r'\1',text)

class Notion:
    def __init__(self,hermes):self.hermes=hermes;self.server=None;self.last=0;self.lock=asyncio.Lock()
    async def __aenter__(self):
        sys.path.insert(0,self.hermes)
        from tools.mcp_tool_discovery import _connect_server
        self.server=await _connect_server('notion',{'url':'https://mcp.notion.com/mcp','auth':'oauth','enabled':True})
        return self
    async def __aexit__(self,*args):
        if self.server:await self.server.shutdown()
    async def call(self,name,args):
        # A mutation with an uncertain outcome is reconciled by the caller, not blindly replayed.
        if 'page_id' in args:
            args=dict(args);raw=args['page_id'].split('?')[0].rstrip('/').rsplit('/',1)[-1]
            args['page_id']=str(uuid.UUID(raw))
        async with self.lock:
            await asyncio.sleep(max(0,.4-(time.monotonic()-self.last)));self.last=time.monotonic()
        result=await self.server.session.call_tool(name,args)
        if getattr(result,'is_error',getattr(result,'isError',False)):raise RuntimeError('Notion operation failed: '+name)
        value=unpack(result)
        if isinstance(value,dict) and value.get('type')=='async_task':raise RuntimeError('Notion operation requires reconciliation')
        return value
    async def fetch(self,id,files=False):return await self.call('notion-fetch',{'id':id,'include_file_urls':files})
    async def rows(self,source):
        rows=[]
        for offset in range(0,100000,100):
            value=await self.call('notion-query-data-sources',{'data':{'data_source_urls':[source],'query':f'SELECT url, "상대경로", "원본 제목", "원본 파일", "검증메모" FROM "{source}" ORDER BY url LIMIT 100 OFFSET {offset}'}})
            if not isinstance(value,dict):raise RuntimeError('Invalid Notion query response')
            part=value.get('results',value.get('rows'))
            if not isinstance(part,list):raise RuntimeError('Invalid Notion rows shape: '+','.join(value))
            rows.extend(part)
            if len(part)<100:return rows
        raise RuntimeError('Notion inventory exceeded bound')
