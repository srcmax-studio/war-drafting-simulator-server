import { GoogleGenAI } from "@google/genai";
import { OpenAI } from "openai";

export abstract class GenerationProvider {
    protected model: string;

    protected constructor(config: { apiKey: string, model: string }) {
        this.model = config.model;
    }

    abstract generateStream(prompt: string): AsyncIterable<string>;
}

export class GeminiProvider extends GenerationProvider {
    private ai: GoogleGenAI;

    constructor(config: { apiKey: string, model: string }) {
        super(config);
        this.ai = new GoogleGenAI({ apiKey: config.apiKey });
    }

    async *generateStream(prompt: string): AsyncIterable<string> {
        const response = await this.ai.models.generateContentStream({
            model: this.model,
            contents: prompt
        });

        for await (const chunk of response) {
            if (chunk.candidates) {
                for (const part of chunk.candidates[0].content?.parts ?? []) {
                    if (part.text != undefined && part.text) {
                        yield part.text;
                    }
                }
            }
        }
    }
}

export class OpenAIProvider extends GenerationProvider {
    private ai: OpenAI;
    private useChatCompletions: boolean;

    constructor(config: { baseUrl: string, apiKey: string, model: string, useChatCompletions: boolean }) {
        super(config);

        this.useChatCompletions = config.useChatCompletions;
        this.ai = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey });
    }

    async *generateStream(prompt: string): AsyncIterable<string> {
        if (this.useChatCompletions) {
            const stream = await this.ai.chat.completions.create({
                model: this.model,
                messages: [{role: "user", content: prompt}],
                stream: true
            })

            for await (const chunk of stream) {
                if (chunk.choices[0] && chunk.choices[0].delta.content) {
                    yield chunk.choices[0].delta.content;
                }
            }
        } else {
            const stream = await this.ai.responses.create({
                model: this.model,
                input: [ { role: "user", content: prompt } ],
                stream: true
            });

            for await (const event of stream) {
                if (event.type === "response.output_text.delta") {
                    yield event.delta;
                }
            }
        }
    }
}
