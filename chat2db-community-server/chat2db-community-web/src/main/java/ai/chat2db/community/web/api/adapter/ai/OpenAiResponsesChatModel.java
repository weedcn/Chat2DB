package ai.chat2db.community.web.api.adapter.ai;

import ai.chat2db.community.domain.api.model.ai.AiRuntimeModel;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import org.apache.commons.lang3.StringUtils;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.ToolResponseMessage;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.model.Generation;
import org.springframework.ai.chat.model.ToolContext;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.model.tool.ToolCallingChatOptions;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.ai.tool.definition.ToolDefinition;
import reactor.core.publisher.Flux;
import reactor.core.publisher.FluxSink;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Talks to an OpenAI Responses endpoint, including CC Switch
 * {@code /v1/responses} in front of official Codex.
 */
public class OpenAiResponsesChatModel implements ChatModel {

    private static final int MAX_TOOL_ROUNDS = 6;

    private static final String DEFAULT_BASE_URL = "http://127.0.0.1:15721";

    private final String endpoint;

    private final String apiKey;

    private final String accountId;

    private final String model;

    private final HttpClient httpClient;

    public OpenAiResponsesChatModel(AiRuntimeModel runtimeModel) {
        this.endpoint = endpoint(runtimeModel.getBaseUrl());
        this.apiKey = runtimeModel.getApiKey();
        this.accountId = StringUtils.trimToNull(runtimeModel.getProjectId());
        this.model = runtimeModel.getModel();
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    }

    public static String endpoint(String baseUrl) {
        String normalized = StringUtils.defaultIfBlank(StringUtils.trimToNull(baseUrl), DEFAULT_BASE_URL);
        normalized = StringUtils.removeEnd(normalized, "/");
        for (String suffix : List.of("/v1/chat/completions", "/chat/completions", "/v1/responses", "/responses", "/v1")) {
            if (StringUtils.endsWithIgnoreCase(normalized, suffix)) {
                normalized = normalized.substring(0, normalized.length() - suffix.length());
                normalized = StringUtils.removeEnd(normalized, "/");
            }
        }
        return normalized + "/v1/responses";
    }

    @Override
    public ChatResponse call(Prompt prompt) {
        StringBuilder text = new StringBuilder();
        List<AssistantMessage.ToolCall> toolCalls = new ArrayList<>();
        stream(prompt).doOnNext(chunk -> {
            if (chunk.getResult() == null || chunk.getResult().getOutput() == null) {
                return;
            }
            AssistantMessage output = chunk.getResult().getOutput();
            if (output.getText() != null) {
                text.append(output.getText());
            }
            if (output.hasToolCalls()) {
                toolCalls.addAll(output.getToolCalls());
            }
        }).blockLast();
        return chunk(text.toString(), toolCalls);
    }

    @Override
    public Flux<ChatResponse> stream(Prompt prompt) {
        return Flux.create(sink -> {
            Thread worker = new Thread(() -> {
                try {
                    run(prompt, sink);
                    sink.complete();
                }
                catch (Exception exception) {
                    if (!sink.isCancelled()) {
                        sink.error(exception);
                    }
                }
            }, "openai-responses");
            worker.setDaemon(true);
            sink.onCancel(worker::interrupt);
            sink.onDispose(worker::interrupt);
            worker.start();
        }, FluxSink.OverflowStrategy.BUFFER);
    }

    private void run(Prompt prompt, FluxSink<ChatResponse> sink) throws Exception {
        List<Map<String, Object>> input = new ArrayList<>();
        String instructions = copyHistory(prompt.getInstructions(), input);
        List<ToolCallback> tools = toolCallbacks(prompt);
        Map<String, Object> toolContext = toolContext(prompt);
        for (int round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (Thread.currentThread().isInterrupted() || sink.isCancelled()) {
                return;
            }
            List<FunctionCall> calls = post(instructions, input, tools, sink);
            if (calls.isEmpty()) {
                return;
            }
            List<AssistantMessage.ToolCall> emitted = new ArrayList<>();
            for (FunctionCall call : calls) {
                emitted.add(new AssistantMessage.ToolCall(call.toolId(), "function", call.name,
                        call.arguments.length() == 0 ? "{}" : call.arguments.toString()));
            }
            sink.next(chunk("", emitted));
            for (FunctionCall call : calls) {
                String arguments = call.arguments.length() == 0 ? "{}" : call.arguments.toString();
                input.add(functionCallItem(call));
                input.add(Map.of(
                        "type", "function_call_output",
                        "call_id", call.toolId(),
                        "output", invokeTool(tools, call.name, arguments, toolContext)));
            }
        }
    }

    private List<FunctionCall> post(String instructions, List<Map<String, Object>> input, List<ToolCallback> tools,
                                    FluxSink<ChatResponse> sink) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("instructions", instructions);
        body.put("input", input);
        body.put("stream", true);
        body.put("store", false);
        body.put("tools", toolDefinitions(tools));
        body.put("parallel_tool_calls", true);

        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(endpoint))
                .timeout(Duration.ofMinutes(5))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.toJSONString(body)));
        if (accountId != null) {
            request.header("chatgpt-account-id", accountId);
        }

        HttpResponse<InputStream> response = httpClient.send(request.build(), HttpResponse.BodyHandlers.ofInputStream());
        try (InputStream stream = response.body()) {
            if (response.statusCode() / 100 != 2) {
                String errorBody = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
                throw new IllegalStateException("Responses API HTTP " + response.statusCode() + ": " + abbreviate(errorBody));
            }
            return readEvents(stream, sink);
        }
    }

    private List<FunctionCall> readEvents(InputStream stream, FluxSink<ChatResponse> sink) throws Exception {
        List<FunctionCall> calls = new ArrayList<>();
        String eventName = "";
        StringBuilder data = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (Thread.currentThread().isInterrupted() || sink.isCancelled()) {
                    break;
                }
                if (line.isEmpty()) {
                    if (data.length() > 0) {
                        dispatch(eventName, data.toString(), sink, calls);
                    }
                    eventName = "";
                    data.setLength(0);
                    continue;
                }
                if (line.startsWith("event:")) {
                    eventName = line.substring("event:".length()).trim();
                }
                else if (line.startsWith("data:")) {
                    if (data.length() > 0) {
                        data.append('\n');
                    }
                    data.append(line.substring("data:".length()).trim());
                }
            }
        }
        if (data.length() > 0) {
            dispatch(eventName, data.toString(), sink, calls);
        }
        return calls.stream().filter(call -> StringUtils.isNotBlank(call.name)).toList();
    }

    private void dispatch(String eventName, String data, FluxSink<ChatResponse> sink, List<FunctionCall> calls) {
        if ("[DONE]".equals(data) || !data.startsWith("{")) {
            return;
        }
        JSONObject json = JSON.parseObject(data);
        String type = StringUtils.defaultIfBlank(json.getString("type"), eventName);
        if ("response.output_text.delta".equals(type)) {
            String delta = json.getString("delta");
            if (StringUtils.isNotEmpty(delta)) {
                sink.next(chunk(delta, List.of()));
            }
            return;
        }
        if ("response.output_item.added".equals(type)) {
            JSONObject item = json.getJSONObject("item");
            if (item != null && "function_call".equals(item.getString("type"))) {
                calls.add(FunctionCall.start(item));
            }
            return;
        }
        if ("response.function_call_arguments.delta".equals(type)) {
            FunctionCall call = find(calls, json.getString("item_id"));
            if (call != null && json.getString("delta") != null) {
                call.arguments.append(json.getString("delta"));
            }
            return;
        }
        if ("response.output_item.done".equals(type)) {
            JSONObject item = json.getJSONObject("item");
            if (item != null && "function_call".equals(item.getString("type"))) {
                FunctionCall call = find(calls, item.getString("id"));
                if (call == null) {
                    call = FunctionCall.start(item);
                    calls.add(call);
                }
                if (StringUtils.isNotBlank(item.getString("arguments"))) {
                    call.arguments.setLength(0);
                    call.arguments.append(item.getString("arguments"));
                }
                if (StringUtils.isNotBlank(item.getString("name"))) {
                    call.name = item.getString("name");
                }
                if (StringUtils.isNotBlank(item.getString("call_id"))) {
                    call.callId = item.getString("call_id");
                }
            }
            return;
        }
        if ("error".equals(type) || "response.failed".equals(type)) {
            throw new IllegalStateException("Responses API failed: " + abbreviate(data));
        }
    }

    private static String copyHistory(List<Message> messages, List<Map<String, Object>> input) {
        StringBuilder instructions = new StringBuilder();
        for (Message message : messages) {
            if (message instanceof ToolResponseMessage toolMessage) {
                for (ToolResponseMessage.ToolResponse response : toolMessage.getResponses()) {
                    input.add(Map.of(
                            "type", "function_call_output",
                            "call_id", response.id(),
                            "output", StringUtils.defaultString(response.responseData())));
                }
                continue;
            }
            if (message instanceof AssistantMessage assistantMessage && assistantMessage.hasToolCalls()) {
                if (StringUtils.isNotEmpty(assistantMessage.getText())) {
                    input.add(Map.of("role", "assistant", "content", assistantMessage.getText()));
                }
                for (AssistantMessage.ToolCall toolCall : assistantMessage.getToolCalls()) {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("type", "function_call");
                    item.put("call_id", toolCall.id());
                    item.put("name", toolCall.name());
                    item.put("arguments", StringUtils.defaultIfBlank(toolCall.arguments(), "{}"));
                    input.add(item);
                }
                continue;
            }
            String text = StringUtils.defaultString(message.getText());
            switch (message.getMessageType()) {
                case SYSTEM -> {
                    if (instructions.length() > 0 && StringUtils.isNotEmpty(text)) {
                        instructions.append("\n\n");
                    }
                    instructions.append(text);
                }
                case USER -> input.add(Map.of("role", "user", "content", text));
                case ASSISTANT -> input.add(Map.of("role", "assistant", "content", text));
                default -> {
                }
            }
        }
        return instructions.toString();
    }

    private static List<ToolCallback> toolCallbacks(Prompt prompt) {
        if (prompt.getOptions() instanceof ToolCallingChatOptions options && options.getToolCallbacks() != null) {
            return options.getToolCallbacks();
        }
        return List.of();
    }

    private static Map<String, Object> toolContext(Prompt prompt) {
        if (prompt.getOptions() instanceof ToolCallingChatOptions options && options.getToolContext() != null) {
            return options.getToolContext();
        }
        return Map.of();
    }

    private static List<Map<String, Object>> toolDefinitions(List<ToolCallback> tools) {
        List<Map<String, Object>> definitions = new ArrayList<>();
        for (ToolCallback tool : tools) {
            ToolDefinition definition = tool.getToolDefinition();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("type", "function");
            item.put("name", definition.name());
            item.put("description", StringUtils.defaultString(definition.description()));
            item.put("parameters", parseSchema(definition.inputSchema()));
            definitions.add(item);
        }
        return definitions;
    }

    private static Object parseSchema(String schema) {
        if (StringUtils.isBlank(schema)) {
            return JSON.parseObject("{\"type\":\"object\",\"properties\":{}}");
        }
        try {
            return JSON.parse(schema);
        }
        catch (Exception exception) {
            return JSON.parseObject("{\"type\":\"object\",\"properties\":{}}");
        }
    }

    private static String invokeTool(List<ToolCallback> tools, String name, String arguments,
                                     Map<String, Object> toolContext) {
        for (ToolCallback tool : tools) {
            if (!tool.getToolDefinition().name().equals(name)) {
                continue;
            }
            try {
                return StringUtils.defaultString(tool.call(arguments, new ToolContext(toolContext)));
            }
            catch (Exception exception) {
                return "Tool " + name + " failed: " + StringUtils.defaultString(exception.getMessage());
            }
        }
        return "Tool " + name + " is not available.";
    }

    private static Map<String, Object> functionCallItem(FunctionCall call) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("type", "function_call");
        item.put("call_id", call.toolId());
        item.put("name", call.name);
        item.put("arguments", call.arguments.length() == 0 ? "{}" : call.arguments.toString());
        return item;
    }

    private static FunctionCall find(List<FunctionCall> calls, String itemId) {
        if (StringUtils.isBlank(itemId)) {
            return calls.isEmpty() ? null : calls.get(calls.size() - 1);
        }
        for (FunctionCall call : calls) {
            if (itemId.equals(call.itemId) || itemId.equals(call.callId)) {
                return call;
            }
        }
        return null;
    }

    private static ChatResponse chunk(String text, List<AssistantMessage.ToolCall> toolCalls) {
        AssistantMessage message = AssistantMessage.builder()
                .content(text == null ? "" : text)
                .toolCalls(toolCalls)
                .build();
        return new ChatResponse(List.of(new Generation(message)));
    }

    private static String abbreviate(String value) {
        if (value == null) {
            return "";
        }
        String trimmed = value.replaceAll("\\s+", " ").trim();
        return trimmed.length() <= 800 ? trimmed : trimmed.substring(0, 800) + "...";
    }

    private static final class FunctionCall {
        private String itemId;
        private String callId;
        private String name;
        private final StringBuilder arguments = new StringBuilder();

        private static FunctionCall start(JSONObject item) {
            FunctionCall call = new FunctionCall();
            call.itemId = item.getString("id");
            call.callId = StringUtils.defaultIfBlank(item.getString("call_id"), call.itemId);
            call.name = item.getString("name");
            if (item.getString("arguments") != null) {
                call.arguments.append(item.getString("arguments"));
            }
            return call;
        }

        private String toolId() {
            return StringUtils.defaultIfBlank(callId, StringUtils.defaultIfBlank(itemId, name));
        }
    }
}
