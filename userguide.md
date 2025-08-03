# User Guide: Prompt Optimization Assistant

## Overview
This assistant specializes in transforming user prompts into highly effective, detailed instructions for AI systems. It analyzes prompts for structure, clarity, specificity, and effectiveness, then rewrites them to maximize precision and desired outcomes.

## How to Use

1. **Start the Application**  
   - **Linux/macOS:** Run `./setup.sh` in your terminal.
   - **Windows:** Double-click `setup.bat` or run it from Command Prompt.
   - **Docker:**  
     1. Build: `docker build -t prompt-optimizer .`  
     2. Run: `docker run -d -p 3000:3000 --env-file .env prompt-optimizer`

2. **Submit Your Prompt**  
   Provide your original prompt. The assistant will analyze and optimize it.

3. **Review the Optimized Prompt**  
   The assistant will return an improved version, maintaining your intent but enhancing clarity, specificity, and structure.

4. **Implement or Further Refine**  
   Use the optimized prompt as-is or iterate further for your specific use case.

## Optimization Criteria

- **Clarity:** Removes ambiguity and vague language.
- **Specificity:** Adds context, constraints, and examples where needed.
- **Structure:** Organizes information logically, emphasizing key requirements.
- **Actionability:** Uses direct, actionable instructions.
- **Edge Cases:** Considers potential misinterpretations or exceptions.
- **Format:** Specifies desired output format and style.

## Example

**Original Prompt:**  
"Write a summary of this article."

**Optimized Prompt:**  
"Summarize the following article in 3-4 sentences, focusing on the main arguments and conclusions. Use clear, concise language suitable for a general audience. Exclude minor details and examples. Format the summary as a single paragraph."