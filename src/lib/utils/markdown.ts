import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkHtml from 'remark-html';
import remarkGfm from 'remark-gfm';

export async function parseMarkdown(content: string): Promise<string> {
    const result = await unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkHtml, { sanitize: false })
        .process(content);

    return String(result);
}

export function extractTodos(content: string): { line: number; text: string }[] {
    const todos: { line: number; text: string }[] = [];
    const lines = content.split('\n');

    lines.forEach((line, index) => {
        const todoMatch = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/);
        if (todoMatch) {
            todos.push({
                line: index + 1,
                text: todoMatch[3].trim()
            });
        }
    });

    return todos;
}

export function processWikilinks(html: string, onClick: (title: string) => void): string {
    const wikiLinkRegex = /\[\[(.+?)\]\]/g;
    return html.replace(wikiLinkRegex, (match, title) => {
        return `<a class="wikilink" data-title="${title}" href="#">${title}</a>`;
    });
}