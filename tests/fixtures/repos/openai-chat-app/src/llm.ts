import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function summarize(text: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Summarize concisely.' },
      { role: 'user', content: text },
    ],
    max_tokens: 256,
    temperature: 0.2,
  });
  return response.choices[0]?.message?.content ?? '';
}

export async function embedTexts(texts: string[]) {
  return client.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
}
