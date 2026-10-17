"""Headless Notion MCP client using the existing Hermes OAuth token store."""
import asyncio,json,re,sys,time,uuid,string
from pathlib import Path

class NotionError(RuntimeError):pass

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
    if text.startswith('`') and text.endswith('`'):text=text[1:-1]
    for _ in range(5):
        clean=re.sub(r'\[([^\]]+)\]\([^)]+\)',r'\1',text)
        if clean==text:break
        text=clean
    return re.sub(r'\\(['+re.escape(string.punctuation)+r'])',r'\1',text)

class Notion:
    def __init__(self,hermes):self.hermes=hermes;self.server=None;self.last=0;self.lock=asyncio.Lock();self.row_cache={}
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
        value=unpack(result)
        if getattr(result,'is_error',getattr(result,'isError',False)):
            code=value.get('code','unknown') if isinstance(value,dict) else 'unknown'
            code=code if re.fullmatch(r'[a-z_]{1,80}',str(code)) else 'unknown'
            raise NotionError(name+':'+code)
        if isinstance(value,dict) and value.get('type')=='async_task':raise NotionError(name+':requires_reconciliation')
        return value
    async def fetch(self,id,files=False):return await self.call('notion-fetch',{'id':id,'include_file_urls':files})
    async def rows(self,source,columns='url, "상대경로", "원본 제목", "원본 파일", "검증메모"'):
        if source.startswith('https://') and '?v=' in source:
            if source in self.row_cache:return self.row_cache[source]
            database,view=source.split('?v=',1)
            config=page_text(await self.fetch(database));selected=None
            for vid,raw in re.findall(r'<view url="\{\{view://([^}]+)\}\}">\s*(.*?)\s*</view>',config,re.S):
                if vid.replace('-','')==view.replace('-',''):selected=json.loads(raw)
            if selected is None or selected.get('filter') or selected.get('filters'):raise NotionError('sync_view_missing_or_filtered')
            rows=[];cursor=None;seen=set()
            for _ in range(1000):
                data={'mode':'view','view_url':source,'page_size':100}
                if cursor:data['start_cursor']=cursor
                value=await self.call('notion-query-data-sources',{'data':data})
                part=value.get('results',value.get('rows')) if isinstance(value,dict) else None
                if not isinstance(part,list):raise NotionError('invalid_view_response')
                rows.extend(part)
                if not value.get('has_more'):
                    self.row_cache[source]=rows;return rows
                cursor=value.get('next_cursor')
                if not cursor or cursor in seen:raise NotionError('invalid_view_pagination')
                seen.add(cursor)
            raise NotionError('view_inventory_exceeded_bound')
        rows=[]
        for offset in range(0,100000,100):
            value=await self.call('notion-query-data-sources',{'data':{'data_source_urls':[source],'query':f'SELECT {columns} FROM "{source}" ORDER BY url LIMIT 100 OFFSET {offset}'}})
            if not isinstance(value,dict):raise RuntimeError('Invalid Notion query response')
            part=value.get('results',value.get('rows'))
            if not isinstance(part,list):raise RuntimeError('Invalid Notion rows shape: '+','.join(value))
            rows.extend(part)
            if len(part)<100:return rows
        raise RuntimeError('Notion inventory exceeded bound')
