/**
 * dataops-claude-api — Config node storing Anthropic API settings
 */
module.exports = function(RED) {

    function DataOpsClaudeApiConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name || '';
        this.model = config.model || 'claude-sonnet-4-6';
        this.baseUrl = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
        this.maxTokens = parseInt(config.maxTokens) || 16384;
        this.temperature = parseFloat(config.temperature);
        if (isNaN(this.temperature)) this.temperature = 0.7;
    }

    RED.nodes.registerType("dataops-claude-api", DataOpsClaudeApiConfigNode, {
        credentials: {
            apiKey: { type: "password" }
        }
    });
};
