import zipfile, os, shutil

src = r'D:\简历\f23015409王婧昀.docx'
dst = r'D:\简历\f23015409王婧昀_新.docx'
tmp = r'D:/RenSheet/.tmp_resume/docx_edit/'

if os.path.exists(tmp):
    shutil.rmtree(tmp)
os.makedirs(tmp)

with zipfile.ZipFile(src, 'r') as z:
    z.extractall(tmp)

doc_path = tmp + 'word/document.xml'
with open(doc_path, 'r', encoding='utf-8') as f:
    doc = f.read()

# Find old block: from paraId="6E075EE4" paragraph to just before <w:sectPr
old_block_start = doc.find('<w:p w14:paraId="6E075EE4"')
old_block_end = doc.find('<w:sectPr')

print(f'Block start: {old_block_start}, end: {old_block_end}')

new_block = '''<w:p w14:paraId="6E075EE4" w14:textId="09CE544E" w:rsidR="00E91480" w:rsidRDefault="00000000"><w:pPr><w:spacing w:before="120" w:after="40"/><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="2E86C1"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>RenSheet &#8212; </w:t></w:r><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="2E86C1"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>网页版拼团金额计算工具</w:t></w:r><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="2E86C1"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>（个人全栈项目）</w:t></w:r><w:r><w:rPr><w:color w:val="5D6D7E"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr><w:t xml:space="preserve">  2025.05</w:t></w:r></w:p><w:p w14:paraId="2BD036F5" w14:textId="77777777" w:rsidR="00E91480" w:rsidRDefault="00000000"><w:pPr><w:spacing w:before="20" w:after="60"/><w:ind w:left="360"/><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr></w:pPr><w:r><w:rPr><w:color w:val="5D6D7E"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t>纯前端二次元周边拼团金额计算工具，支持多排表导入、分类/清单式肾表生成、国际运费分摊、二次调价退补款计算，已部署上线并使用自定义域名。</w:t></w:r></w:p><w:p w14:paraId="688336F9" w14:textId="77777777" w:rsidR="00546636" w:rsidRDefault="00000000" w:rsidP="00546636"><w:pPr><w:spacing w:before="30" w:after="30"/><w:ind w:left="360"/><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">  独立设计并开发 5 个完整功能页面，使用 SheetJS 解析 Excel 排表、ExcelJS 生成格式化输出文件，实现纯前端数据闭环</w:t></w:r></w:p><w:p w14:paraId="7C53911E" w14:textId="273FD3F9" w:rsidR="00E91480" w:rsidRDefault="00546636" w:rsidP="00546636"><w:pPr><w:spacing w:before="30" w:after="30"/><w:ind w:firstLineChars="200" w:firstLine="400"/><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">  上线 2 日内请求量突破 7000 次，独立访客 500 人，部署于 Cloudflare Pages 及自定义域名 rensheet.top</w:t></w:r></w:p>'''

old_block = doc[old_block_start:old_block_end]
new_doc = doc.replace(old_block, new_block)

with open(doc_path, 'w', encoding='utf-8') as f:
    f.write(new_doc)

# Repack to docx
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zout:
    for root, dirs, files in os.walk(tmp):
        for file in files:
            full = os.path.join(root, file)
            arcname = os.path.relpath(full, tmp)
            arcname = arcname.replace('\\', '/')
            zout.write(full, arcname)

print('Done! Output:', dst)
