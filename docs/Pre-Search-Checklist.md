**Pre-Search Checklist**

Complete this before writing code. Save your AI conversation as a reference document.

## **Phase 1: Define Your Constraints**

### **1\. Domain Selection**

* Which domain: healthcare, insurance, finance, legal, or custom?

* What specific use cases will you support?

* What are the verification requirements for this domain?

* What data sources will you need access to?

### **2\. Scale & Performance**

* Expected query volume?

* Acceptable latency for responses?

* Concurrent user requirements?

* Cost constraints for LLM calls?

### **3\. Reliability Requirements**

* What's the cost of a wrong answer in your domain?

* What verification is non-negotiable?

* Human-in-the-loop requirements?

* Audit/compliance needs?

### **4\. Team & Skill Constraints**

* Familiarity with agent frameworks?

* Experience with your chosen domain?

* Comfort with eval/testing frameworks?

## **Phase 2: Architecture Discovery**

### **5\. Agent Framework Selection**

* LangChain vs LangGraph vs CrewAI vs custom?

* Single agent or multi-agent architecture?

* State management requirements?

* Tool integration complexity?

### **6\. LLM Selection**

* GPT-5 vs Claude vs open source?

* Function calling support requirements?

* Context window needs?

* Cost per query acceptable?

### **7\. Tool Design**

* What tools does your agent need?

* External API dependencies?

* Mock vs real data for development?

* Error handling per tool?

### **8\. Observability Strategy**

* LangSmith vs Braintrust vs other?

* What metrics matter most?

* Real-time monitoring needs?

* Cost tracking requirements?

### **9\. Eval Approach**

* How will you measure correctness?

* Ground truth data sources?

* Automated vs human evaluation?

* CI integration for eval runs?

### **10\. Verification Design**

* What claims must be verified?

* Fact-checking data sources?

* Confidence thresholds?

* Escalation triggers?

## **Phase 3: Post-Stack Refinement**

### **11\. Failure Mode Analysis**

* What happens when tools fail?

* How to handle ambiguous queries?

* Rate limiting and fallback strategies?

* Graceful degradation approach?

### **12\. Security Considerations**

* Prompt injection prevention?

* Data leakage risks?

* API key management?

* Audit logging requirements?

### **13\. Testing Strategy**

* Unit tests for tools?

* Integration tests for agent flows?

* Adversarial testing approach?

* Regression testing setup?

### **14\. Open Source Planning**

* What will you release?

* Licensing considerations?

* Documentation requirements?

* Community engagement plan?

### **15\. Deployment & Operations**

* Hosting approach?

* CI/CD for agent updates?

* Monitoring and alerting?

* Rollback strategy?

### **16\. Iteration Planning**

* How will you collect user feedback?

* Eval-driven improvement cycle?

* Feature prioritization approach?

* Long-term maintenance plan?
